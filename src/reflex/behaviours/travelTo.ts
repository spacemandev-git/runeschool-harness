import { TRAVEL_NETWORKS, type JsonValue, type TileCoord, type TravelNetwork } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { chebyshev } from '../geometry.ts';

interface Departure { readonly at: TileCoord; readonly loc: number; }
interface TravelToParams {
  readonly network: TravelNetwork;
  readonly from?: Departure;
  readonly destination?: string;
  readonly code?: string;
  readonly item?: number;
  readonly run?: boolean;
  readonly timeoutTicks?: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const tile = (value: unknown): value is TileCoord => object(value) && Number.isSafeInteger(value.x)
  && Number.isSafeInteger(value.z) && Number.isSafeInteger(value.level) && (value.level as number) >= 0 && (value.level as number) <= 3;
const departure = (value: unknown): value is Departure => object(value) && tile(value.at)
  && Number.isSafeInteger(value.loc) && (value.loc as number) >= 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.network !== 'string' || !TRAVEL_NETWORKS.includes(value.network as TravelNetwork)) errors.push({ path: 'network', message: 'must be a travel network' });
  if (value.from !== undefined && !departure(value.from)) errors.push({ path: 'from', message: 'must be a positioned loc target' });
  if (value.destination !== undefined && (typeof value.destination !== 'string' || value.destination.length === 0)) errors.push({ path: 'destination', message: 'must be non-empty' });
  if (value.code !== undefined && (typeof value.code !== 'string' || value.code.length === 0)) errors.push({ path: 'code', message: 'must be non-empty' });
  if (value.item !== undefined && !positive(value.item)) errors.push({ path: 'item', message: 'must be a positive item id' });
  if (value.network === 'fairy-ring' && typeof value.code !== 'string') errors.push({ path: 'code', message: 'is required for fairy-ring travel' });
  if (value.network !== 'fairy-ring' && value.network !== 'tablet' && typeof value.destination !== 'string') errors.push({ path: 'destination', message: 'is required for this network' });
  if ((value.network === 'jewellery' || value.network === 'tablet') && !positive(value.item)) errors.push({ path: 'item', message: 'is required for this network' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class TravelToBehaviour implements Behaviour {
  readonly id = 'travel-to';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: TravelToParams;
  private startedTick?: number;
  private travelling = false;

  constructor(params: TravelToParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'travelled' && event.data.entity === snapshot.self.entity
        && event.data.network === this.config.network) {
        return { state: 'done', summary: `travelled to ${event.data.destination}` };
      }
      if (event.type === 'travel-denied' && event.data.entity === snapshot.self.entity
        && event.data.network === this.config.network) {
        return { state: 'failed', reason: event.data.reason, retryable: event.data.reason === 'too_far' };
      }
    }
    if (this.travelling) return { state: 'running', note: `travelling by ${this.config.network}` };
    if (this.config.from !== undefined && chebyshev(snapshot.self.at, this.config.from.at) > 1) {
      if (initial || snapshot.self.activity.kind === 'idle') {
        const outcome = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: this.config.from.at } });
        if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'movement rejected', retryable: outcome.code !== 'invalid_destination' };
      }
      return { state: 'running', note: `walking to ${this.config.network} departure` };
    }
    const outcome = await ctx.act({
      type: 'travel',
      data: {
        network: this.config.network,
        ...(this.config.from === undefined ? {} : { from: this.config.from }),
        ...(this.config.destination === undefined ? {} : { destination: this.config.destination }),
        ...(this.config.code === undefined ? {} : { code: this.config.code }),
        ...(this.config.item === undefined ? {} : { item: this.config.item })
      }
    });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'travel rejected', retryable: outcome.code === 'too_far' };
    this.travelling = true;
    return { state: 'running', note: `travelling by ${this.config.network}` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `travel-to ${this.config.destination ?? this.config.code ?? this.config.network}`.slice(0, 80); }
}

export const TRAVEL_TO: BehaviourDefinition = {
  id: 'travel-to', description: 'Walk to an optional transport departure loc and travel to a selected destination.',
  paramsSchema: { type: 'object', required: ['network'], additionalProperties: false, properties: {
    network: { type: 'string', enum: TRAVEL_NETWORKS },
    from: { type: 'object', required: ['at', 'loc'], additionalProperties: false, properties: {
      at: { type: 'object', required: ['x', 'z', 'level'], additionalProperties: false, properties: {
        x: { type: 'integer' }, z: { type: 'integer' }, level: { type: 'integer', minimum: 0, maximum: 3 }
      } }, loc: { type: 'integer', minimum: 0 }
    } },
    destination: { type: 'string' }, code: { type: 'string' }, item: { type: 'integer', minimum: 1 },
    run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 200 }
  } },
  validate, create: (params) => new TravelToBehaviour(params as unknown as TravelToParams)
};
