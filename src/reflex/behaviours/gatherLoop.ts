import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { NodeView, WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';
import { BankRunBehaviour } from './bankRun.ts';

interface GatherParams {
  readonly node?: string; readonly skill?: string; readonly until: 'inventory-full' | { readonly count: number };
  readonly then: 'stop' | 'drop-all' | 'bank'; readonly bankAt?: TileCoord; readonly itemName?: string;
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (value.node !== undefined && typeof value.node !== 'string') errors.push({ path: 'node', message: 'must be a string' });
  if (value.skill !== undefined && typeof value.skill !== 'string') errors.push({ path: 'skill', message: 'must be a string' });
  if (value.node === undefined && value.skill === undefined) errors.push({ path: 'params', message: 'node or skill is required' });
  if (value.until !== 'inventory-full' && (!obj(value.until) || !Number.isSafeInteger(value.until.count) || (value.until.count as number) <= 0)) errors.push({ path: 'until', message: 'must be inventory-full or a positive count' });
  if (!['stop', 'drop-all', 'bank'].includes(String(value.then))) errors.push({ path: 'then', message: 'must be stop, drop-all, or bank' });
  if (value.then === 'bank' && !obj(value.bankAt)) errors.push({ path: 'bankAt', message: 'is required for bank' });
  if (value.itemName !== undefined && typeof value.itemName !== 'string') errors.push({ path: 'itemName', message: 'must be a string' });
  return { ok: errors.length === 0, errors };
}

class GatherBehaviour implements Behaviour {
  readonly id = 'gather-loop'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: GatherParams;
  private target?: string; private count = 0; private gathered = new Set<number>(); private avoided = new Set<string>(); private phase: 'gather' | 'drop' | 'bank' = 'gather'; private dropped = new Set<number>(); private bank?: BankRunBehaviour;
  constructor(params: GatherParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private pick(s: WorldSnapshot): NodeView | undefined {
    return s.nodes.filter((n) => !n.depleted && !this.avoided.has(n.id) && (this.config.node === undefined || n.id === this.config.node) && (this.config.skill === undefined || n.skill.toLowerCase() === this.config.skill.toLowerCase()))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0];
  }
  private reached(): boolean { return this.config.until !== 'inventory-full' && this.count >= this.config.until.count; }
  private async gather(ctx: ReflexContext): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot();
    for (const event of ctx.pulseEvents) if (event.type === 'gathered' && event.data.entity === s.self.entity) this.gathered.add(event.data.item);
    for (const event of ctx.pulseEvents) {
      if (event.type === 'item-added' && event.data.entity === s.self.entity && this.gathered.has(event.data.item)) this.count += event.data.amount;
      if (event.type === 'node-respawned') this.avoided.delete(event.data.node);
      if ((event.type === 'node-depleted' && event.data.node === this.target) || (event.type === 'gather-stopped' && event.data.node === this.target)) { this.avoided.add(event.data.node); this.target = undefined; }
    }
    if (s.inventoryFree === 0 || this.reached()) return this.beginThen(ctx);
    let node = this.target === undefined ? undefined : s.nodes.find((n) => n.id === this.target && !n.depleted);
    node ??= this.pick(s);
    if (node === undefined) return { state: 'running', note: 'seeking node' };
    this.target = node.id;
    if (!adjacent(s.self.at, node.at)) await ctx.act({ type: 'walk', data: { dest: node.at } });
    else if (s.self.activity.kind !== 'gathering' || s.self.activity.node !== node.id) {
      const out = await ctx.act({ type: 'gather', data: { node: node.id } });
      if (!out.ok && out.code === 'inventory_full') return this.beginThen(ctx);
    }
    return { state: 'running', note: `${this.count} gathered` };
  }
  private async beginThen(ctx: ReflexContext): Promise<BehaviourStatus> {
    if (this.config.then === 'stop') return { state: 'done', summary: `${this.count} gathered` };
    if (this.config.then === 'drop-all') { this.phase = 'drop'; return this.drop(ctx); }
    this.phase = 'bank';
    this.bank = new BankRunBehaviour({ bankAt: this.config.bankAt!, deposit: 'all' });
    return this.bank.start(ctx);
  }
  private async drop(ctx: ReflexContext): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot();
    const slot = s.inventory.filter((v) => !this.dropped.has(v.slot) && (this.config.itemName !== undefined ? (v.name ?? '').toLowerCase().includes(this.config.itemName.toLowerCase()) : this.gathered.has(v.item)))
      .sort((a, b) => a.slot - b.slot)[0];
    if (slot !== undefined) { this.dropped.add(slot.slot); await ctx.act({ type: 'drop', data: { slot: slot.slot } }); return { state: 'running', note: 'dropping gathered items' }; }
    if (this.config.until === 'inventory-full') { this.phase = 'gather'; this.dropped.clear(); this.target = undefined; return this.gather(ctx); }
    return { state: 'done', summary: `${this.count} gathered and dropped` };
  }
  async start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.gather(ctx); }
  async step(ctx: ReflexContext): Promise<BehaviourStatus> {
    if (this.phase === 'drop') return this.drop(ctx);
    if (this.phase === 'bank') {
      const status = await this.bank!.step(ctx);
      if (status.state === 'done') { await this.bank!.stop(ctx, 'done'); this.bank = undefined; this.phase = 'gather'; this.target = undefined; return this.gather(ctx); }
      return status;
    }
    return this.gather(ctx);
  }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> { if (this.bank !== undefined) await this.bank.stop(ctx, why); }
  describe(): string { return `gather-loop ${this.target ?? this.config.node ?? this.config.skill ?? 'node'} (${this.count})`.slice(0, 80); }
}

export const GATHER_LOOP: BehaviourDefinition = {
  id: 'gather-loop', description: 'Gather nodes, then stop, drop, or bank.',
  paramsSchema: { type: 'object', required: ['until', 'then'], properties: { node: { type: 'string' }, skill: { type: 'string' }, until: { oneOf: [{ const: 'inventory-full' }, { type: 'object' }] }, then: { enum: ['stop', 'drop-all', 'bank'] }, bankAt: { type: 'object' }, itemName: { type: 'string' } } },
  validate, create: (params) => new GatherBehaviour(params as unknown as GatherParams)
};
