import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { adjacent } from '../geometry.ts';

interface FarmPatchParam {
  readonly id: string;
  readonly at: TileCoord;
  readonly loc: number;
  readonly seed: number;
  readonly compost?: number;
}
interface FarmRunParams { readonly patches: readonly FarmPatchParam[]; readonly run?: boolean; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const tile = (value: unknown): value is TileCoord => object(value) && Number.isSafeInteger(value.x)
  && Number.isSafeInteger(value.z) && Number.isSafeInteger(value.level) && (value.level as number) >= 0 && (value.level as number) <= 3;
const patch = (value: unknown): value is FarmPatchParam => object(value) && typeof value.id === 'string'
  && value.id.trim() !== '' && tile(value.at) && positive(value.loc) && positive(value.seed)
  && (value.compost === undefined || positive(value.compost));

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!Array.isArray(value.patches) || value.patches.length === 0 || !value.patches.every(patch)) {
    errors.push({ path: 'patches', message: 'must be a non-empty array of id/at/loc/seed patch plans' });
  } else if (new Set(value.patches.map((entry) => entry.id)).size !== value.patches.length) {
    errors.push({ path: 'patches', message: 'patch ids must be unique' });
  }
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

type Phase = 'rake' | 'compost' | 'plant' | 'growing' | 'harvest' | 'done';
class FarmRunBehaviour implements Behaviour {
  readonly id = 'farm-run';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: FarmRunParams;
  private readonly phases = new Map<string, Phase>();
  private startedTick?: number;
  private waiting?: string;
  private harvested = 0;

  constructor(params: FarmRunParams) {
    this.config = params;
    this.params = params as unknown as Readonly<Record<string, JsonValue>>;
    for (const entry of params.patches) this.phases.set(entry.id, 'rake');
  }

  private current(): FarmPatchParam | undefined {
    return this.config.patches.find((entry) => {
      const phase = this.phases.get(entry.id);
      return phase !== 'growing' && phase !== 'done';
    });
  }

  private async drive(ctx: ReflexContext, _initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 20_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'died' && event.data.entity === snapshot.self.entity) return { state: 'failed', reason: 'self died', retryable: false };
      if (event.type === 'farmed' && event.data.entity === snapshot.self.entity) {
        const plan = this.config.patches.find((entry) => entry.id === event.data.patch);
        if (plan === undefined) continue;
        if (event.data.action === 'rake') this.phases.set(plan.id, plan.compost === undefined ? 'plant' : 'compost');
        if (event.data.action === 'compost') this.phases.set(plan.id, 'plant');
        if (event.data.action === 'plant') this.phases.set(plan.id, 'growing');
        if (event.data.action === 'harvest') this.harvested++;
        this.waiting = undefined;
      }
      if (event.type === 'patch-changed') {
        const plan = this.config.patches.find((entry) => entry.id === event.data.patch);
        if (plan === undefined) continue;
        if (event.data.state === 'grown') this.phases.set(plan.id, 'harvest');
        if (event.data.state === 'empty' && this.phases.get(plan.id) === 'harvest') {
          this.phases.set(plan.id, 'done');
          this.waiting = undefined;
        }
        if (event.data.state === 'dead') return { state: 'failed', reason: `${plan.id} crop died`, retryable: true };
      }
    }
    if ([...this.phases.values()].every((phase) => phase === 'done')) {
      return { state: 'done', summary: `harvested ${this.harvested} items from ${this.config.patches.length} patches` };
    }
    const target = this.current();
    if (target === undefined) return { state: 'running', note: 'waiting for crops to grow' };
    const phase = this.phases.get(target.id)!;
    if (!adjacent(snapshot.self.at, target.at)) {
      if (snapshot.self.activity.kind !== 'idle') return { state: 'running', note: `travelling to ${target.id}` };
      const outcome = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: target.at } });
      return outcome.ok
        ? { state: 'running', note: `travelling to ${target.id}` }
        : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'movement rejected', retryable: outcome.code !== 'invalid_destination' };
    }
    if (this.waiting === target.id) return { state: 'running', note: `${phase} ${target.id}` };
    const action = phase;
    const item = phase === 'plant' ? target.seed : phase === 'compost' ? target.compost : undefined;
    const outcome = await ctx.act({ type: 'farm', data: {
      patch: { at: target.at, loc: target.loc }, action, ...(item === undefined ? {} : { item })
    } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? `${phase} rejected`, retryable: outcome.code === 'busy' || outcome.code === 'too_far' || outcome.code === 'inventory_full' };
    this.waiting = target.id;
    return { state: 'running', note: `${phase} ${target.id}` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string {
    const done = [...this.phases.values()].filter((phase) => phase === 'done').length;
    return `farm-run ${done}/${this.config.patches.length} patches harvested`.slice(0, 80);
  }
}

const tileSchema = { type: 'object', required: ['x', 'z', 'level'], additionalProperties: false, properties: {
  x: { type: 'integer' }, z: { type: 'integer' }, level: { type: 'integer', minimum: 0, maximum: 3 }
} } as const;
export const FARM_RUN: BehaviourDefinition = {
  id: 'farm-run', description: 'Rake, compost, and plant configured patches, then revisit and harvest grown crops.',
  paramsSchema: { type: 'object', required: ['patches'], additionalProperties: false, properties: {
    patches: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'at', 'loc', 'seed'], additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1 }, at: tileSchema, loc: { type: 'integer', minimum: 1 },
      seed: { type: 'integer', minimum: 1 }, compost: { type: 'integer', minimum: 1 }
    } } }, run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 20000 }
  } },
  validate, create: (params) => new FarmRunBehaviour(params as unknown as FarmRunParams)
};
