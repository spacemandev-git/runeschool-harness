import {
  eventActor,
  nackCategory,
  type CommandResult,
  type EntityId,
  type InteractTarget,
  type ServerEvent,
  type SpellbookName,
  type TileCoord
} from '../shared/index.ts';
import type { DialogueView, WorldModel } from './percept.ts';
import { CommandRejected, WaitForTimeout, type InstanceStream } from './stream.ts';

export type ActionStatus = 'success' | 'partial' | 'rejected' | 'timeout';

export interface ActionOutcome<E = unknown> {
  readonly status: ActionStatus;
  readonly command: { readonly type: string; readonly data: unknown };
  readonly ack?: CommandResult;
  readonly code?: string;
  readonly category?: ReturnType<typeof nackCategory>;
  readonly evidence: E;
  readonly events: readonly ServerEvent[];
  readonly startedTick: number;
  readonly endedTick: number;
  readonly elapsedMs: number;
}

export interface BotActionsOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface EvidenceWaiter<E> {
  readonly initial: E;
  onEvent(event: ServerEvent, acc: E): { acc: E; done: boolean };
  onTimeout?(acc: E): ActionStatus;
  /**
   * Optional: derive evidence from the accepted ack itself. Return `done: true` for INSTANT
   * commands that emit no per-actor event (e.g. bank deposit/withdraw), so the action resolves
   * `success` without waiting for the event stream.
   */
  onAck?(ack: CommandResult, acc: E): { acc: E; done: boolean } | undefined;
}

export interface ActionStream {
  send(type: string, data: unknown): Promise<CommandResult>;
  waitFor<T>(
    predicate: (event: ServerEvent) => T | undefined,
    opts?: { readonly timeoutMs?: number }
  ): Promise<T>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tile(value: unknown): TileCoord | undefined {
  const data = record(value);
  const x = finite(data.x);
  const z = finite(data.z);
  const level = finite(data.level);
  return x === undefined || z === undefined || level === undefined ? undefined : { x, z, level };
}

function distance(left: TileCoord, right: TileCoord): number {
  return left.level === right.level
    ? Math.max(Math.abs(left.x - right.x), Math.abs(left.z - right.z))
    : Number.POSITIVE_INFINITY;
}

function dialogueNode(data: Record<string, unknown>): DialogueView {
  const options = Array.isArray(data.options)
    ? data.options.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return {
    active: true,
    ...(finite(data.npc) === undefined ? {} : { npc: finite(data.npc) }),
    ...(typeof data.speakerTag !== 'string' ? {} : { speaker: data.speakerTag }),
    ...(typeof data.text === 'string'
      ? { text: data.text }
      : typeof data.prompt === 'string' ? { text: data.prompt } : {}),
    ...(options === undefined ? {} : { options })
  };
}

/** Commands paired with the server events that prove their observable effects. */
export class BotActions {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly stream: InstanceStream | ActionStream,
    private readonly model: WorldModel,
    private readonly entity: EntityId,
    opts: BotActionsOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async walkTo(
    dest: TileCoord,
    opts: { readonly run?: boolean; readonly stopWithin?: number; readonly timeoutMs?: number } = {}
  ): Promise<ActionOutcome<{ arrived: boolean; distance: number }>> {
    await this.model.start();
    const startDistance = distance(this.model.snapshot().self.at, dest);
    const stopWithin = opts.stopWithin ?? 0;
    let stopped = false;
    const outcome = await this.perform(opts.run === true ? 'run' : 'walk', { entity: this.entity, dest }, {
      initial: { arrived: startDistance <= stopWithin, distance: startDistance },
      onEvent: (event, acc) => {
        if (event.type === 'move-blocked' || event.type === 'move-rejected') {
          stopped = true;
          return { acc, done: true };
        }
        if (event.type !== 'moved' && event.type !== 'teleported') return { acc, done: false };
        const at = tile(record(event.data).to);
        if (at === undefined) return { acc, done: false };
        const remaining = distance(at, dest);
        const next = { arrived: remaining <= stopWithin, distance: remaining };
        return { acc: next, done: next.arrived };
      },
      onTimeout: (acc) => acc.arrived ? 'success' : acc.distance < startDistance ? 'partial' : 'timeout'
    }, { timeoutMs: opts.timeoutMs });
    if (!stopped || outcome.status === 'rejected') return outcome;
    return { ...outcome, status: outcome.evidence.distance < startDistance ? 'partial' : 'timeout' };
  }

  attack(
    target: EntityId,
    opts: { readonly untilDead?: boolean; readonly timeoutMs?: number } = {}
  ): Promise<ActionOutcome<{ engaged: boolean; targetDied: boolean; damageDealt: number }>> {
    return this.perform('attack', { entity: this.entity, target }, {
      initial: { engaged: false, targetDied: false, damageDealt: 0 } as {
        engaged: boolean; targetDied: boolean; damageDealt: number;
      },
      onEvent: (event, acc) => {
        const data = record(event.data);
        if (event.type === 'died' && data.entity === target) {
          return { acc: { ...acc, targetDied: true }, done: opts.untilDead === true };
        }
        if ((event.type !== 'swing' && event.type !== 'hit') || data.target !== target) {
          return { acc, done: false };
        }
        const next = {
          ...acc,
          engaged: true,
          damageDealt: acc.damageDealt + (event.type === 'hit' ? finite(data.damage) ?? 0 : 0)
        };
        return { acc: next, done: opts.untilDead !== true };
      },
      onTimeout: (acc) => acc.engaged || acc.damageDealt > 0 ? 'partial' : 'timeout'
    }, { timeoutMs: opts.timeoutMs });
  }

  async gather(
    node: string,
    opts: { readonly count?: number; readonly timeoutMs?: number } = {}
  ): Promise<ActionOutcome<{ gathered: number; stopped?: string }>> {
    const count = opts.count ?? 1;
    const outcome = await this.perform('gather', { entity: this.entity, node }, {
      initial: { gathered: 0 } as { gathered: number; stopped?: string },
      onEvent: (event, acc) => {
        const data = record(event.data);
        if (event.type === 'gathered' && data.node === node) {
          const next = { ...acc, gathered: acc.gathered + 1 };
          return { acc: next, done: next.gathered >= count };
        }
        if (event.type === 'gather-stopped' && data.node === node) {
          return { acc: { ...acc, stopped: String(data.reason ?? 'stopped') }, done: true };
        }
        return { acc, done: false };
      },
      onTimeout: (acc) => acc.gathered > 0 ? 'partial' : 'timeout'
    }, { timeoutMs: opts.timeoutMs });
    return outcome.status === 'success' && outcome.evidence.gathered < count
      ? { ...outcome, status: outcome.evidence.stopped === undefined ? 'timeout' : 'partial' }
      : outcome;
  }

  async fish(
    spot: EntityId,
    option: string,
    opts: { readonly count?: number; readonly timeoutMs?: number } = {}
  ): Promise<ActionOutcome<{ caught: number; stopped?: string }>> {
    const count = opts.count ?? 1;
    const outcome = await this.perform('fish', { entity: this.entity, spot, option }, {
      initial: { caught: 0 } as { caught: number; stopped?: string },
      onEvent: (event, acc) => {
        const data = record(event.data);
        if (event.type === 'fished') {
          const next = { ...acc, caught: acc.caught + 1 };
          return { acc: next, done: next.caught >= count };
        }
        if (event.type === 'fishing-stopped') {
          return { acc: { ...acc, stopped: String(data.reason ?? 'stopped') }, done: true };
        }
        return { acc, done: false };
      },
      onTimeout: (acc) => acc.caught > 0 ? 'partial' : 'timeout'
    }, { timeoutMs: opts.timeoutMs });
    return outcome.status === 'success' && outcome.evidence.caught < count
      ? { ...outcome, status: outcome.evidence.stopped === undefined ? 'timeout' : 'partial' }
      : outcome;
  }

  pickup(groundItem: number): Promise<ActionOutcome<{ item?: number; amount?: number }>> {
    return this.perform('pickup', { entity: this.entity, groundItem }, {
      initial: {},
      onEvent: (event, acc) => {
        const data = record(event.data);
        return event.type === 'ground-item-picked-up' && data.id === groundItem
          ? { acc: { item: finite(data.item), amount: finite(data.amount) }, done: true }
          : { acc, done: false };
      }
    });
  }

  eat(item: number): Promise<ActionOutcome<{ healed: number }>> {
    return this.perform('eat', { entity: this.entity, item }, {
      initial: { healed: 0 },
      onEvent: (event, acc) => event.type === 'ate' && record(event.data).item === item
        ? { acc: { healed: finite(record(event.data).heal) ?? 0 }, done: true }
        : { acc, done: false }
    });
  }

  equip(slot: number): Promise<ActionOutcome<{ equipped: boolean }>> {
    return this.perform('equip', { entity: this.entity, slot }, {
      initial: { equipped: false } as { equipped: boolean },
      onEvent: (event, acc) => event.type === 'equipped'
        ? { acc: { equipped: true }, done: true }
        : { acc, done: false }
    });
  }

  talk(dialogue: string): Promise<ActionOutcome<{ node?: DialogueView }>> {
    return this.perform('talk', { entity: this.entity, dialogue }, {
      initial: {},
      onEvent: (event, acc) => event.type === 'dialogue-node'
        ? { acc: { node: dialogueNode(record(event.data)) }, done: true }
        : event.type === 'dialogue-ended' ? { acc, done: true } : { acc, done: false }
    });
  }

  dialogueAdvance(choice?: number): Promise<ActionOutcome<{ node?: DialogueView; ended: boolean }>> {
    return this.perform('dialogue-advance', {
      entity: this.entity,
      ...(choice === undefined ? {} : { choice })
    }, {
      initial: { ended: false } as { node?: DialogueView; ended: boolean },
      onEvent: (event, acc) => event.type === 'dialogue-node'
        ? { acc: { node: dialogueNode(record(event.data)), ended: false }, done: true }
        : event.type === 'dialogue-ended'
          ? { acc: { ended: true }, done: true }
          : { acc, done: false }
    });
  }

  interact(target: InteractTarget, option: string): Promise<ActionOutcome<{ handler?: string }>> {
    return this.handlerAction('interact', { entity: this.entity, target, option }, 'interacted');
  }

  useItemOn(slot: number, target: InteractTarget): Promise<ActionOutcome<{ handler?: string }>> {
    return this.handlerAction('use-item-on', { entity: this.entity, slot, target }, 'item-used');
  }

  bankDeposit(item: number, amount: number): Promise<ActionOutcome<{ deposited: number }>> {
    return this.amountAction('bank-deposit', { entity: this.entity, item, amount }, 'item-removed', item, amount, 'deposited');
  }

  bankWithdraw(item: number, amount: number, noted?: boolean): Promise<ActionOutcome<{ withdrawn: number }>> {
    return this.amountAction('bank-withdraw', {
      entity: this.entity, item, amount, ...(noted === undefined ? {} : { noted })
    }, 'item-added', item, amount, 'withdrawn');
  }

  shopBuy(npc: EntityId, item: number, amount: number): Promise<ActionOutcome<{ bought: number }>> {
    return this.amountAction('shop-buy', { entity: this.entity, npc, item, amount }, 'shop-bought', item, amount, 'bought');
  }

  shopSell(npc: EntityId, item: number, amount: number): Promise<ActionOutcome<{ sold: number }>> {
    return this.amountAction('shop-sell', { entity: this.entity, npc, item, amount }, 'shop-sold', item, amount, 'sold');
  }

  /** Cast or replace this actor's ballot. Accepted votes resolve from the command ack. */
  vote(poll: string, target: EntityId | null): Promise<ActionOutcome<{ voted: boolean }>> {
    return this.perform('vote', { entity: this.entity, poll, target }, {
      initial: { voted: false } as { voted: boolean },
      onAck: () => ({ acc: { voted: true }, done: true }),
      onEvent: (_event, acc) => ({ acc, done: false })
    });
  }

  /** Switch spellbooks immediately; this slice intentionally has no altar requirement. */
  switchSpellbook(book: SpellbookName): Promise<ActionOutcome<{ book: SpellbookName }>> {
    return this.perform('switch-spellbook', { entity: this.entity, book }, {
      initial: { book },
      onAck: () => ({ acc: { book }, done: true }),
      onEvent: (_event, acc) => ({ acc, done: false })
    });
  }

  async perform<E>(
    type: string,
    data: unknown,
    until: EvidenceWaiter<E>,
    opts: { readonly timeoutMs?: number } = {}
  ): Promise<ActionOutcome<E>> {
    await this.model.start();
    const command = { type, data };
    const startedAt = this.now();
    const before = this.model.snapshot();
    const startedTick = before.tick;
    const baselineSeq = before.lastEventSeq;
    let acc = until.initial;
    let endedTick = startedTick;
    const events: ServerEvent[] = [];
    let ack: CommandResult;
    try {
      ack = await this.stream.send(type, data);
      endedTick = Math.max(endedTick, ack.tick);
      if (!ack.ok) {
        const code = ack.error ?? 'unknown_error';
        return {
          status: 'rejected', command, ack, code, category: nackCategory(code),
          evidence: acc, events, startedTick, endedTick,
          elapsedMs: this.now() - startedAt
        };
      }
      this.model.noteAction({ type, data: record(data), tick: ack.tick, ok: ack.ok });
      const fromAck = until.onAck?.(ack, acc);
      if (fromAck !== undefined) {
        acc = fromAck.acc;
        if (fromAck.done) {
          return {
            status: 'success', command, ack, evidence: acc, events,
            startedTick, endedTick, elapsedMs: this.now() - startedAt
          };
        }
      }
    } catch (error) {
      if (error instanceof CommandRejected) {
        const rejectedAck: CommandResult = {
          id: error.id,
          ok: false,
          error: error.code,
          tick: error.tick
        };
        return {
          status: 'rejected', command, ack: rejectedAck, code: error.code,
          category: nackCategory(error.code), evidence: acc, events,
          startedTick, endedTick: error.tick, elapsedMs: this.now() - startedAt
        };
      }
      return {
        status: 'timeout', command, evidence: acc, events,
        startedTick, endedTick, elapsedMs: this.now() - startedAt
      };
    }

    try {
      await this.stream.waitFor((event) => {
        if (event.seq <= baselineSeq || eventActor(event) !== this.entity) return undefined;
        events.push(event);
        endedTick = Math.max(endedTick, event.tick);
        const next = until.onEvent(event, acc);
        acc = next.acc;
        return next.done ? { done: true } : undefined;
      }, { timeoutMs: opts.timeoutMs ?? this.timeoutMs });
      return {
        status: 'success', command, ack, evidence: acc, events,
        startedTick, endedTick, elapsedMs: this.now() - startedAt
      };
    } catch (error) {
      const status = error instanceof WaitForTimeout
        ? until.onTimeout?.(acc) ?? 'timeout'
        : 'timeout';
      return {
        status, command, ack, evidence: acc, events,
        startedTick, endedTick, elapsedMs: this.now() - startedAt
      };
    }
  }

  private handlerAction(
    type: string,
    data: unknown,
    eventType: string
  ): Promise<ActionOutcome<{ handler?: string }>> {
    return this.perform(type, data, {
      initial: {},
      onEvent: (event, acc) => event.type === eventType
        ? {
            acc: typeof record(event.data).handler === 'string'
              ? { handler: record(event.data).handler as string }
              : {},
            done: true
          }
        : { acc, done: false }
    });
  }

  private amountAction<K extends 'deposited' | 'withdrawn' | 'bought' | 'sold'>(
    type: string,
    data: unknown,
    eventType: string,
    item: number,
    targetAmount: number,
    key: K
  ): Promise<ActionOutcome<Record<K, number>>> {
    // Bank transfers are INSTANT and emit no per-actor item events: the ack is the evidence.
    const ackResolved = type === 'bank-deposit' || type === 'bank-withdraw';
    return this.perform(type, data, {
      initial: { [key]: 0 } as Record<K, number>,
      ...(ackResolved ? {
        onAck: (_ack: CommandResult, acc: Record<K, number>) => ({ acc: { ...acc, [key]: targetAmount }, done: true })
      } : {}),
      onEvent: (event, acc) => {
        const eventData = record(event.data);
        if (event.type !== eventType || eventData.item !== item) return { acc, done: false };
        const next = { ...acc, [key]: acc[key] + (finite(eventData.amount) ?? 0) };
        return { acc: next, done: next[key] >= targetAmount };
      },
      onTimeout: (acc) => acc[key] > 0 ? 'partial' : 'timeout'
    });
  }
}

export type { InteractTarget } from '../shared/index.ts';
