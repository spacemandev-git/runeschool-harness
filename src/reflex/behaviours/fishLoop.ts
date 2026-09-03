import type { FishingOption, JsonValue, TileCoord } from '#protocol';
import { FISHING_OPTIONS } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { NearbyEntityView, WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';
import { BankRunBehaviour } from './bankRun.ts';

interface FishParams {
  readonly spot?: number; readonly option: FishingOption; readonly until: 'inventory-full' | { readonly count: number };
  readonly then: 'stop' | 'drop-all' | 'bank'; readonly bankAt?: TileCoord; readonly itemName?: string;
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (value.spot !== undefined && (!Number.isSafeInteger(value.spot) || (value.spot as number) <= 0)) errors.push({ path: 'spot', message: 'must be positive' });
  if (!FISHING_OPTIONS.includes(value.option as FishingOption)) errors.push({ path: 'option', message: 'unknown fishing option' });
  if (value.until !== 'inventory-full' && (!obj(value.until) || !Number.isSafeInteger(value.until.count) || (value.until.count as number) <= 0)) errors.push({ path: 'until', message: 'must be inventory-full or a positive count' });
  if (!['stop', 'drop-all', 'bank'].includes(String(value.then))) errors.push({ path: 'then', message: 'must be stop, drop-all, or bank' });
  if (value.then === 'bank' && !obj(value.bankAt)) errors.push({ path: 'bankAt', message: 'required for bank' });
  return { ok: errors.length === 0, errors };
}
class FishBehaviour implements Behaviour {
  readonly id = 'fish-loop'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: FishParams; private target?: number; private count = 0; private caught = new Set<number>(); private phase: 'fish' | 'drop' | 'bank' = 'fish'; private dropped = new Set<number>(); private bank?: BankRunBehaviour;
  constructor(params: FishParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private pick(s: WorldSnapshot): NearbyEntityView | undefined {
    const candidates = s.nearby.filter((v) => v.kind === 'npc' && (this.config.spot === undefined || v.id === this.config.spot));
    const fishingSpots = this.config.spot === undefined ? candidates.filter((v) => (v.name ?? '').toLowerCase().includes('fishing')) : candidates;
    return (fishingSpots.length > 0 ? fishingSpots : candidates).sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
  }
  private reached(): boolean { return this.config.until !== 'inventory-full' && this.count >= this.config.until.count; }
  private async fish(ctx: ReflexContext): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot();
    for (const event of ctx.pulseEvents) if (event.type === 'fished' && event.data.entity === s.self.entity) this.caught.add(event.data.item);
    for (const event of ctx.pulseEvents) {
      if (event.type === 'item-added' && event.data.entity === s.self.entity && this.caught.has(event.data.item)) this.count += event.data.amount;
      if (event.type === 'fishing-stopped' && event.data.entity === s.self.entity) this.target = undefined;
    }
    if (s.inventoryFree === 0 || this.reached()) return this.beginThen(ctx);
    const spot = this.target === undefined ? this.pick(s) : s.nearby.find((v) => v.id === this.target);
    if (spot === undefined) return { state: 'running', note: 'seeking fishing spot' };
    this.target = spot.id;
    if (!adjacent(s.self.at, spot.at)) await ctx.act({ type: 'walk', data: { dest: spot.at } });
    else if (s.self.activity.kind !== 'fishing' || s.self.activity.spot !== spot.id) {
      const out = await ctx.act({ type: 'fish', data: { spot: spot.id, option: this.config.option } });
      if (!out.ok && out.code === 'inventory_full') return this.beginThen(ctx);
    }
    return { state: 'running', note: `${this.count} caught` };
  }
  private async beginThen(ctx: ReflexContext): Promise<BehaviourStatus> {
    if (this.config.then === 'stop') return { state: 'done', summary: `${this.count} caught` };
    if (this.config.then === 'drop-all') { this.phase = 'drop'; return this.drop(ctx); }
    this.phase = 'bank'; this.bank = new BankRunBehaviour({ bankAt: this.config.bankAt!, deposit: 'all' }); return this.bank.start(ctx);
  }
  private async drop(ctx: ReflexContext): Promise<BehaviourStatus> {
    const slot = ctx.view.snapshot().inventory.filter((v) => !this.dropped.has(v.slot) && (this.config.itemName !== undefined ? (v.name ?? '').toLowerCase().includes(this.config.itemName.toLowerCase()) : this.caught.has(v.item))).sort((a, b) => a.slot - b.slot)[0];
    if (slot !== undefined) { this.dropped.add(slot.slot); await ctx.act({ type: 'drop', data: { slot: slot.slot } }); return { state: 'running', note: 'dropping fish' }; }
    if (this.config.until === 'inventory-full') { this.phase = 'fish'; this.dropped.clear(); this.target = undefined; return this.fish(ctx); }
    return { state: 'done', summary: `${this.count} caught and dropped` };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.fish(ctx); }
  async step(ctx: ReflexContext): Promise<BehaviourStatus> { if (this.phase === 'drop') return this.drop(ctx); if (this.phase === 'bank') { const status = await this.bank!.step(ctx); if (status.state === 'done') { await this.bank!.stop(ctx, 'done'); this.bank = undefined; this.phase = 'fish'; this.target = undefined; return this.fish(ctx); } return status; } return this.fish(ctx); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> { if (this.bank !== undefined) await this.bank.stop(ctx, why); }
  describe(): string { return `fish-loop ${this.target ?? 'nearest'} ${this.config.option} (${this.count})`.slice(0, 80); }
}
export const FISH_LOOP: BehaviourDefinition = { id: 'fish-loop', description: 'Fish repeatedly, then stop, drop, or bank.', paramsSchema: { type: 'object', required: ['option', 'until', 'then'], properties: { spot: { type: 'number' }, option: { enum: [...FISHING_OPTIONS] }, until: { oneOf: [{ const: 'inventory-full' }, { type: 'object' }] }, then: { enum: ['stop', 'drop-all', 'bank'] }, bankAt: { type: 'object' }, itemName: { type: 'string' } } }, validate, create: (params) => new FishBehaviour(params as unknown as FishParams) };
