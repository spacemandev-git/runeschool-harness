import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { NearbyEntityView, WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';

interface SlayerLoopParams { readonly master: number; readonly radius?: number; readonly run?: boolean; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.master)) errors.push({ path: 'master', message: 'must be a positive entity id' });
  if (value.radius !== undefined && (typeof value.radius !== 'number' || !Number.isFinite(value.radius) || value.radius < 0)) errors.push({ path: 'radius', message: 'must be non-negative' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class SlayerLoopBehaviour implements Behaviour {
  readonly id = 'slayer-loop';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: SlayerLoopParams;
  private startedTick?: number;
  private task?: string;
  private npcs: readonly number[] = [];
  private remaining = 0;
  private target?: number;
  private requested = false;

  constructor(params: SlayerLoopParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private pick(snapshot: WorldSnapshot): NearbyEntityView | undefined {
    const accepted = new Set(this.npcs);
    return snapshot.nearby.filter((entry) => entry.kind === 'npc' && entry.npc !== undefined
      && accepted.has(entry.npc) && entry.distance <= (this.config.radius ?? 15)
      && (entry.hp === undefined || entry.hp.current > 0))
      .sort((left, right) => left.distance - right.distance || left.id - right.id)[0];
  }

  private async engage(ctx: ReflexContext, target: NearbyEntityView): Promise<BehaviourStatus> {
    this.target = target.id;
    const snapshot = ctx.view.snapshot();
    const outcome = !adjacent(snapshot.self.at, target.at)
      ? await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: target.at } })
      : await ctx.act({ type: 'attack', data: { target: target.id } });
    if (!outcome.ok) {
      return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'Slayer action rejected', retryable: outcome.code !== 'invalid_destination' };
    }
    return { state: 'running', note: `${this.task ?? 'task'}: ${this.remaining} remaining` };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 1_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    if (ctx.pulseEvents.some((event) => event.type === 'died' && event.data.entity === snapshot.self.entity)) {
      return { state: 'failed', reason: 'self died', retryable: false };
    }
    for (const event of ctx.pulseEvents) {
      if (event.type === 'slayer-assigned' && event.data.entity === snapshot.self.entity) {
        this.task = event.data.task; this.npcs = event.data.npcs; this.remaining = event.data.amount; this.target = undefined;
      }
      if (event.type === 'slayer-kill' && event.data.entity === snapshot.self.entity) {
        this.remaining = event.data.remaining; this.target = undefined;
      }
      if (event.type === 'slayer-complete' && event.data.entity === snapshot.self.entity) {
        return { state: 'done', summary: `${event.data.task} task complete; streak ${event.data.streak}` };
      }
    }
    if (initial && !this.requested) {
      this.requested = true;
      const outcome = await ctx.act({ type: 'slayer-task', data: { master: this.config.master } });
      return outcome.ok
        ? { state: 'running', note: 'waiting for Slayer assignment' }
        : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'task request rejected', retryable: false };
    }
    if (this.task === undefined) return { state: 'running', note: 'waiting for Slayer assignment' };
    let target = this.target === undefined ? undefined : snapshot.nearby.find((entry) => entry.id === this.target
      && entry.kind === 'npc' && (entry.hp === undefined || entry.hp.current > 0));
    target ??= this.pick(snapshot);
    if (target === undefined) { this.target = undefined; return { state: 'running', note: `seeking ${this.task}` }; }
    if (!adjacent(snapshot.self.at, target.at)) return this.engage(ctx, target);
    if (snapshot.self.combat.target !== target.id) return this.engage(ctx, target);
    return { state: 'running', note: `${this.task}: ${this.remaining} remaining` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `slayer-loop ${this.task ?? 'requesting task'} (${this.remaining || '?'} remaining)`.slice(0, 80); }
}

export const SLAYER_LOOP: BehaviourDefinition = {
  id: 'slayer-loop', description: 'Request a Slayer task, seek matching nearby NPCs, and fight until completion.',
  paramsSchema: { type: 'object', required: ['master'], additionalProperties: false, properties: {
    master: { type: 'integer', minimum: 1 }, radius: { type: 'number', minimum: 0, default: 15 },
    run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 1000 }
  } },
  validate, create: (params) => new SlayerLoopBehaviour(params as unknown as SlayerLoopParams)
};
