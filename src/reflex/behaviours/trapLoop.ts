import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface TrapLoopParams { readonly item: number; readonly count: number; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.item)) errors.push({ path: 'item', message: 'must be a positive trap item id' });
  if (!positive(value.count)) errors.push({ path: 'count', message: 'must be a positive trap count' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

type TrapState = 'armed' | 'caught' | 'collapsed' | 'checking';
class TrapLoopBehaviour implements Behaviour {
  readonly id = 'trap-loop';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: TrapLoopParams;
  private readonly traps = new Map<number, TrapState>();
  private startedTick?: number;
  private laying = false;
  private catches = 0;

  constructor(params: TrapLoopParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async act(ctx: ReflexContext, action: 'lay-trap' | 'check-trap' | 'dismantle', trap?: number): Promise<BehaviourStatus> {
    const outcome = await ctx.act({
      type: 'hunt',
      data: { action, ...(action === 'lay-trap' ? { item: this.config.item } : { target: { kind: 'npc', id: trap! } }) }
    });
    if (!outcome.ok) {
      return { state: 'failed', reason: outcome.code ?? outcome.message ?? `${action} rejected`, retryable: outcome.code === 'busy' || outcome.code === 'trap_limit' || outcome.code === 'trap_empty' };
    }
    if (action === 'lay-trap') this.laying = true;
    else if (action === 'check-trap') this.traps.set(trap!, 'checking');
    else this.traps.delete(trap!);
    return { state: 'running', note: `${this.traps.size}/${this.config.count} traps; ${this.catches} catches` };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const self = ctx.view.snapshot().self.entity;
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 10_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'died' && event.data.entity === self) return { state: 'failed', reason: 'self died', retryable: false };
      if (event.type === 'trap-laid' && event.data.entity === self) {
        this.traps.set(event.data.trap, 'armed');
        this.laying = false;
      }
      if (event.type === 'trap-caught' && event.data.entity === self) this.traps.set(event.data.trap, 'caught');
      if (event.type === 'trap-collapsed' && event.data.entity === self) this.traps.set(event.data.trap, 'collapsed');
      if (event.type === 'hunted' && event.data.entity === self) {
        const checked = [...this.traps].find(([, state]) => state === 'checking');
        if (checked !== undefined) this.traps.delete(checked[0]);
        this.catches++;
      }
    }
    const caught = [...this.traps].find(([, state]) => state === 'caught');
    if (caught !== undefined) return this.act(ctx, 'check-trap', caught[0]);
    const collapsed = [...this.traps].find(([, state]) => state === 'collapsed');
    if (collapsed !== undefined) return this.act(ctx, 'dismantle', collapsed[0]);
    if ((initial || !this.laying) && this.traps.size < this.config.count) return this.act(ctx, 'lay-trap');
    return { state: 'running', note: `${this.traps.size}/${this.config.count} traps; ${this.catches} catches` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {
    if (why !== 'replaced' && why !== 'cancelled') return;
    for (const trap of [...this.traps.keys()].sort((left, right) => left - right)) {
      await ctx.act({ type: 'hunt', data: { action: 'dismantle', target: { kind: 'npc', id: trap } } });
    }
  }
  describe(): string { return `trap-loop ${this.traps.size}/${this.config.count} traps (${this.catches} catches)`.slice(0, 80); }
}

export const TRAP_LOOP: BehaviourDefinition = {
  id: 'trap-loop', description: 'Maintain a fixed number of Hunter traps, checking catches and re-laying them.',
  paramsSchema: { type: 'object', required: ['item', 'count'], additionalProperties: false, properties: {
    item: { type: 'integer', minimum: 1 }, count: { type: 'integer', minimum: 1 },
    timeoutTicks: { type: 'integer', minimum: 1, default: 10000 }
  } },
  validate, create: (params) => new TrapLoopBehaviour(params as unknown as TrapLoopParams)
};
