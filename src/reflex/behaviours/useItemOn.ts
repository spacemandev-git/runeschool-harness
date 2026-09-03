import type { InteractTarget, JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';

interface UseItemOnParams { readonly slot: number; readonly target: InteractTarget; readonly run?: boolean; readonly timeoutTicks?: number; }
const obj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const tile = (value: unknown): value is TileCoord => obj(value) && ['x', 'z', 'level'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
function validTarget(value: unknown): value is InteractTarget { if (!obj(value)) return false; if (value.kind === 'npc' || value.kind === 'player' || value.kind === 'ground-item') return positive(value.id); return value.kind === 'loc' && positive(value.loc) && tile(value.at); }
function validate(value: unknown): ValidationResult { const errors: { path: string; message: string }[] = []; if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] }; if (!Number.isSafeInteger(value.slot) || (value.slot as number) < 0) errors.push({ path: 'slot', message: 'must be a non-negative integer' }); if (!validTarget(value.target)) errors.push({ path: 'target', message: 'must be a valid npc, player, ground-item, or loc target' }); if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' }); if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' }); return { ok: errors.length === 0, errors }; }
function resolveTarget(target: InteractTarget, snapshot: WorldSnapshot): TileCoord | undefined { if (target.kind === 'loc') return target.at; if (target.kind === 'ground-item') return snapshot.groundItems.find((item) => item.id === target.id)?.at; return snapshot.nearby.find((entity) => entity.id === target.id && entity.kind === target.kind)?.at; }
function sameTarget(left: InteractTarget, right: InteractTarget): boolean { if (left.kind !== right.kind) return false; if (left.kind === 'loc' && right.kind === 'loc') return left.loc === right.loc && left.at.x === right.at.x && left.at.z === right.at.z && left.at.level === right.at.level; return left.kind !== 'loc' && right.kind !== 'loc' && left.id === right.id; }

class UseItemOnBehaviour implements Behaviour {
  readonly id = 'use-item-on'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: UseItemOnParams; private startedTick?: number; private sent = false; private item?: number;
  constructor(params: UseItemOnParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot(); this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 100)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) if (event.type === 'item-used' && event.data.entity === snapshot.self.entity && sameTarget(event.data.target, this.config.target) && (this.item === undefined || event.data.item === this.item)) return { state: 'done', summary: 'item use completed' };
    if (this.sent) return { state: 'running', note: 'waiting for item-used' };
    const inventory = snapshot.inventory.find((entry) => entry.slot === this.config.slot);
    if (inventory === undefined) return { state: 'failed', reason: 'empty_slot', retryable: false };
    this.item = inventory.item;
    const at = resolveTarget(this.config.target, snapshot);
    if (at === undefined) return { state: 'failed', reason: 'target not found', retryable: true };
    if (!adjacent(snapshot.self.at, at)) {
      if (initial || snapshot.self.activity.kind === 'idle') {
        const outcome = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: at } });
        if (!outcome.ok && (outcome.code === 'unreachable' || outcome.code === 'invalid_destination')) return { state: 'failed', reason: outcome.code, retryable: false };
      }
      return { state: 'running', note: 'walking to item-use target' };
    }
    const outcome = await ctx.act({ type: 'use-item-on', data: { slot: this.config.slot, target: this.config.target } });
    if (!outcome.ok) { const retryable = outcome.code === 'too_far' || outcome.code === 'unknown_entity' || outcome.code === 'unknown_loc' || outcome.code === 'not_found'; return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'use-item-on rejected', retryable }; }
    this.sent = true; return { state: 'running', note: 'waiting for item-used' };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `use-item-on slot ${this.config.slot} → ${this.config.target.kind}`.slice(0, 80); }
}

const targetSchema = { oneOf: [
  { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { const: 'npc' }, id: { type: 'integer', minimum: 1 } } },
  { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { const: 'player' }, id: { type: 'integer', minimum: 1 } } },
  { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { const: 'ground-item' }, id: { type: 'integer', minimum: 1 } } },
  { type: 'object', required: ['kind', 'at', 'loc'], additionalProperties: false, properties: { kind: { const: 'loc' }, at: { type: 'object', required: ['x', 'z', 'level'], additionalProperties: false, properties: { x: { type: 'number' }, z: { type: 'number' }, level: { type: 'number' } } }, loc: { type: 'integer', minimum: 1 } } }
] } as const;
export const USE_ITEM_ON: BehaviourDefinition = { id: 'use-item-on', description: 'Walk to a target and use an occupied inventory slot on it.', paramsSchema: { type: 'object', required: ['slot', 'target'], additionalProperties: false, properties: { slot: { type: 'integer', minimum: 0 }, target: targetSchema, run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 100 } } }, validate, create: (params) => new UseItemOnBehaviour(params as unknown as UseItemOnParams) };
