import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { WorldSnapshot } from '../../core/percept.ts';
import { chebyshev } from '../geometry.ts';

export interface WalkToParams {
  readonly dest?: TileCoord;
  readonly entity?: number;
  readonly node?: string;
  readonly station?: string;
  readonly groundItem?: number;
  readonly stopWithin?: number;
  readonly run?: boolean;
  readonly timeoutTicks?: number;
}

const ok = (errors: { path: string; message: string }[]): ValidationResult => ({ ok: errors.length === 0, errors });
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateWalkTo(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return ok([{ path: 'params', message: 'must be an object' }]);
  const targets = ['dest', 'entity', 'node', 'station', 'groundItem'].filter((key) => value[key] !== undefined);
  if (targets.length !== 1) errors.push({ path: 'params', message: 'exactly one target is required' });
  if (value.dest !== undefined) {
    if (!obj(value.dest)) errors.push({ path: 'dest', message: 'must be a tile' });
    else for (const key of ['x', 'z', 'level']) if (!finite(value.dest[key])) errors.push({ path: `dest.${key}`, message: 'must be finite' });
  }
  for (const key of ['entity', 'groundItem']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)) errors.push({ path: key, message: 'must be a positive integer' });
  for (const key of ['node', 'station']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key] === '')) errors.push({ path: key, message: 'must be a non-empty string' });
  if (value.stopWithin !== undefined && (!finite(value.stopWithin) || value.stopWithin < 0)) errors.push({ path: 'stopWithin', message: 'must be non-negative' });
  if (value.timeoutTicks !== undefined && (!Number.isSafeInteger(value.timeoutTicks) || (value.timeoutTicks as number) <= 0)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  return ok(errors);
}

export function resolveWalkTarget(params: WalkToParams, s: WorldSnapshot): TileCoord | undefined {
  if (params.dest !== undefined) return params.dest;
  if (params.entity !== undefined) return s.nearby.find((v) => v.id === params.entity)?.at;
  if (params.node !== undefined) return s.nodes.find((v) => v.id === params.node)?.at;
  if (params.station !== undefined) return s.stations.find((v) => v.id === params.station)?.at;
  if (params.groundItem !== undefined) return s.groundItems.find((v) => v.id === params.groundItem)?.at;
  return undefined;
}

export class WalkToBehaviour implements Behaviour {
  readonly id = 'walk-to';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: WalkToParams;
  private startedTick?: number;
  private reissues = 0;
  private target?: TileCoord;
  private remaining = Number.POSITIVE_INFINITY;
  constructor(params: WalkToParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private stopWithin(): number { return this.config.stopWithin ?? (this.config.dest === undefined ? 1 : 0); }
  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 100)) return { state: 'failed', reason: 'timeout', retryable: true };
    const target = resolveWalkTarget(this.config, s);
    if (target === undefined) return { state: 'failed', reason: 'target not found', retryable: true };
    this.target = target;
    this.remaining = chebyshev(s.self.at, target);
    if (this.remaining <= this.stopWithin()) return { state: 'done', summary: 'arrived' };
    if (initial || s.self.activity.kind === 'idle') {
      if (!initial && ++this.reissues > 5) return { state: 'failed', reason: 'stuck', retryable: true };
      const outcome = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: target } });
      if (!outcome.ok && (outcome.code === 'unreachable' || outcome.code === 'invalid_destination')) return { state: 'failed', reason: outcome.code, retryable: false };
    }
    return { state: 'running', note: `${this.remaining} tiles left` };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string {
    const target = this.target ?? this.config.dest;
    const where = target === undefined ? 'target' : `(${target.x},${target.z},${target.level})`;
    return `walk-to ${where} ${Number.isFinite(this.remaining) ? this.remaining : '?'} tiles left`.slice(0, 80);
  }
}

export const WALK_TO: BehaviourDefinition = {
  id: 'walk-to', description: 'Walk or run to a tile or moving world target.',
  paramsSchema: { type: 'object', properties: { dest: { type: 'object' }, entity: { type: 'number' }, node: { type: 'string' }, station: { type: 'string' }, groundItem: { type: 'number' }, stopWithin: { type: 'number' }, run: { type: 'boolean' }, timeoutTicks: { type: 'number', default: 100 } } },
  validate: validateWalkTo,
  create: (params) => new WalkToBehaviour(params as WalkToParams)
};
