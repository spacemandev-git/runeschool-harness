import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { adjacent } from '../geometry.ts';

interface LocTarget { readonly at: TileCoord; readonly loc: number; }
interface RunecraftLoopParams {
  readonly talisman: number;
  readonly ruin: LocTarget;
  readonly altar: LocTarget;
  readonly run?: boolean;
  readonly timeoutTicks?: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const tile = (value: unknown): value is TileCoord => object(value)
  && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.z)
  && Number.isSafeInteger(value.level) && (value.level as number) >= 0 && (value.level as number) <= 3;
const locTarget = (value: unknown): value is LocTarget => object(value) && positive(value.loc) && tile(value.at);

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.talisman)) errors.push({ path: 'talisman', message: 'must be a positive item id' });
  if (!locTarget(value.ruin)) errors.push({ path: 'ruin', message: 'must be a positioned loc target' });
  if (!locTarget(value.altar)) errors.push({ path: 'altar', message: 'must be a positioned loc target' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class RunecraftLoopBehaviour implements Behaviour {
  readonly id = 'runecraft-loop';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: RunecraftLoopParams;
  private startedTick?: number;
  private phase: 'ruin' | 'entering' | 'altar' | 'crafting' = 'ruin';
  constructor(params: RunecraftLoopParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async move(ctx: ReflexContext, target: LocTarget, note: string): Promise<BehaviourStatus> {
    const outcome = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: target.at } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'movement rejected', retryable: outcome.code !== 'invalid_destination' };
    return { state: 'running', note };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'ruin-entered' && event.data.entity === snapshot.self.entity) this.phase = 'altar';
      if (event.type === 'runes-crafted' && event.data.entity === snapshot.self.entity) {
        return { state: 'done', summary: `crafted ${event.data.amount} runes` };
      }
    }
    if (this.phase === 'ruin' && !snapshot.inventory.some((entry) => entry.item === this.config.talisman)) {
      return { state: 'failed', reason: `missing talisman ${this.config.talisman}`, retryable: true };
    }
    if (this.phase === 'ruin') {
      if (!adjacent(snapshot.self.at, this.config.ruin.at)) {
        if (initial || snapshot.self.activity.kind === 'idle') return this.move(ctx, this.config.ruin, 'walking to ruin');
        return { state: 'running', note: 'walking to ruin' };
      }
      const outcome = await ctx.act({ type: 'enter-ruin', data: { ruin: this.config.ruin } });
      if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'ruin entry rejected', retryable: outcome.code === 'too_far' };
      this.phase = 'entering';
      return { state: 'running', note: 'entering ruin' };
    }
    if (this.phase === 'entering') return { state: 'running', note: 'waiting for ruin entry' };
    if (this.phase === 'altar') {
      if (!adjacent(snapshot.self.at, this.config.altar.at)) {
        if (snapshot.self.activity.kind === 'idle') return this.move(ctx, this.config.altar, 'walking to altar');
        return { state: 'running', note: 'walking to altar' };
      }
      const outcome = await ctx.act({ type: 'craft-runes', data: { altar: this.config.altar } });
      if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'craft rejected', retryable: outcome.code === 'too_far' };
      this.phase = 'crafting';
    }
    return { state: 'running', note: 'waiting for crafted runes' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `runecraft-loop ${this.phase}`.slice(0, 80); }
}

const targetSchema = { type: 'object', required: ['at', 'loc'], additionalProperties: false, properties: {
  at: { type: 'object', required: ['x', 'z', 'level'], additionalProperties: false, properties: { x: { type: 'integer' }, z: { type: 'integer' }, level: { type: 'integer', minimum: 0, maximum: 3 } } },
  loc: { type: 'integer', minimum: 1 }
} } as const;

export const RUNECRAFT_LOOP: BehaviourDefinition = {
  id: 'runecraft-loop', description: 'Enter a ruin with a carried talisman, walk to its altar, and craft once.',
  paramsSchema: { type: 'object', required: ['talisman', 'ruin', 'altar'], additionalProperties: false, properties: {
    talisman: { type: 'integer', minimum: 1 }, ruin: targetSchema, altar: targetSchema,
    run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 200 }
  } },
  validate, create: (params) => new RunecraftLoopBehaviour(params as unknown as RunecraftLoopParams)
};
