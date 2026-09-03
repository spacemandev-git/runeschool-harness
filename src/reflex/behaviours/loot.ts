import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { GroundItemView, WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';

interface LootParams { readonly names?: readonly string[]; readonly radius?: number; readonly max?: number; }
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(value: unknown): ValidationResult {
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (value.names !== undefined && (!Array.isArray(value.names) || value.names.some((v) => typeof v !== 'string'))) errors.push({ path: 'names', message: 'must be strings' });
  if (value.radius !== undefined && (typeof value.radius !== 'number' || !Number.isFinite(value.radius) || value.radius < 0)) errors.push({ path: 'radius', message: 'must be non-negative' });
  if (value.max !== undefined && (!Number.isSafeInteger(value.max) || (value.max as number) <= 0)) errors.push({ path: 'max', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}
class LootBehaviour implements Behaviour {
  readonly id = 'loot'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: LootParams; private picked = 0; private nacks = new Map<number, number>(); private collected = new Set<number>();
  constructor(params: LootParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private pick(s: WorldSnapshot): GroundItemView | undefined {
    return s.groundItems.filter((v) => !this.collected.has(v.id) && v.distance <= (this.config.radius ?? 6) && (this.nacks.get(v.id) ?? 0) < 2 && (this.config.names === undefined || this.config.names.some((name) => (v.name ?? '').toLowerCase().includes(name.toLowerCase()))))
      .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
  }
  private async run(ctx: ReflexContext): Promise<BehaviourStatus> {
    if (this.config.max !== undefined && this.picked >= this.config.max) return { state: 'done', summary: `looted ${this.picked}` };
    const s = ctx.view.snapshot(); const item = this.pick(s);
    if (item === undefined) return { state: 'done', summary: `looted ${this.picked}` };
    if (!adjacent(s.self.at, item.at)) await ctx.act({ type: 'walk', data: { dest: item.at } });
    else { const out = await ctx.act({ type: 'pickup', data: { groundItem: item.id } }); if (out.ok) { this.picked++; this.collected.add(item.id); } else this.nacks.set(item.id, (this.nacks.get(item.id) ?? 0) + 1); }
    return { state: 'running', note: `${this.picked} looted` };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.run(ctx); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.run(ctx); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `loot ${this.config.names?.join(',') ?? 'all'} (${this.picked})`.slice(0, 80); }
}
export const LOOT: BehaviourDefinition = { id: 'loot', description: 'Pick up nearby matching ground items.', paramsSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } }, radius: { type: 'number', default: 6 }, max: { type: 'number' } } }, validate, create: (params) => new LootBehaviour(params as LootParams) };
