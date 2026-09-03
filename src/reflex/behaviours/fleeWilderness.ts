import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface FleeWildernessParams {
  readonly radius?: number;
  readonly minWildernessLevel?: number;
  readonly maxWildernessLevel?: number;
  readonly southTiles?: number;
  readonly run?: boolean;
  readonly timeoutTicks?: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  for (const key of ['radius', 'minWildernessLevel', 'maxWildernessLevel', 'southTiles', 'timeoutTicks']) {
    if (value[key] !== undefined && !positive(value[key])) errors.push({ path: key, message: 'must be a positive integer' });
  }
  if (positive(value.minWildernessLevel) && positive(value.maxWildernessLevel)
    && value.minWildernessLevel > value.maxWildernessLevel) errors.push({ path: 'minWildernessLevel', message: 'must not exceed maxWildernessLevel' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  return { ok: errors.length === 0, errors };
}

class FleeWildernessBehaviour implements Behaviour {
  readonly id = 'flee-wilderness';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: FleeWildernessParams;
  private startedTick?: number;
  private fleeing = false;
  private runSet = false;
  constructor(params: FleeWildernessParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    const status = snapshot.self.status;
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return { state: 'failed', reason: 'timeout', retryable: true };
    if ((status?.wildernessLevel ?? 0) === 0) return { state: 'done', summary: this.fleeing ? 'left wilderness' : 'already outside wilderness' };
    const level = status?.wildernessLevel ?? 0;
    const inConfiguredBand = level >= (this.config.minWildernessLevel ?? 1)
      && level <= (this.config.maxWildernessLevel ?? Number.POSITIVE_INFINITY);
    const threat = snapshot.nearby
      .filter((entry) => entry.kind === 'player' && entry.distance <= (this.config.radius ?? 8))
      .sort((left, right) => left.distance - right.distance || left.id - right.id)[0];
    if (!this.fleeing && (!inConfiguredBand || threat === undefined)) return { state: 'running', note: 'watching nearby players' };
    this.fleeing = true;
    if (this.config.run !== false && !this.runSet) {
      const toggle = await ctx.act({ type: 'set-run', data: { enabled: true } });
      if (!toggle.ok && toggle.code !== 'out_of_energy') return { state: 'failed', reason: toggle.code ?? toggle.message ?? 'run toggle rejected', retryable: true };
      this.runSet = toggle.ok;
    }
    if (initial || snapshot.self.activity.kind === 'idle') {
      const dest = { ...snapshot.self.at, z: Math.max(0, snapshot.self.at.z - (this.config.southTiles ?? 8)) };
      const outcome = await ctx.act({ type: 'walk', data: { dest } });
      if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'flee rejected', retryable: outcome.code !== 'invalid_destination' };
    }
    return { state: 'running', note: `fleeing south from entity#${threat?.id ?? 'unknown'}` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `flee-wilderness ${this.fleeing ? 'southbound' : 'watching'}`.slice(0, 80); }
}

export const FLEE_WILDERNESS: BehaviourDefinition = {
  id: 'flee-wilderness', description: 'Flee south when a nearby player threatens the configured wilderness-level band.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {
    radius: { type: 'integer', minimum: 1, default: 8 }, minWildernessLevel: { type: 'integer', minimum: 1 },
    maxWildernessLevel: { type: 'integer', minimum: 1 }, southTiles: { type: 'integer', minimum: 1, default: 8 },
    run: { type: 'boolean', default: true }, timeoutTicks: { type: 'integer', minimum: 1, default: 200 }
  } },
  validate, create: (params) => new FleeWildernessBehaviour(params as FleeWildernessParams)
};
