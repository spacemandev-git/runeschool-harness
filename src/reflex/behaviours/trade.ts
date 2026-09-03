import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { adjacent } from '../geometry.ts';

interface TradeOfferParam { readonly item: number; readonly amount: number; }
interface TradeParams { readonly target: number; readonly offer: readonly TradeOfferParam[]; readonly run?: boolean; readonly timeoutTicks?: number; }
const obj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (!positive(value.target)) errors.push({ path: 'target', message: 'must be a positive entity id' });
  if (!Array.isArray(value.offer)) errors.push({ path: 'offer', message: 'must be an array' });
  else {
    const seen = new Set<number>();
    value.offer.forEach((entry, index) => {
      if (!obj(entry) || !positive(entry.item) || !positive(entry.amount)) errors.push({ path: `offer.${index}`, message: 'must contain positive item and amount integers' });
      else if (seen.has(entry.item)) errors.push({ path: `offer.${index}.item`, message: 'duplicate item; combine its amount' });
      else seen.add(entry.item);
    });
  }
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

type Phase = 'request' | 'wait-open' | 'offer' | 'wait-confirm' | 'confirm' | 'wait-done';
class TradeBehaviour implements Behaviour {
  readonly id = 'trade'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: TradeParams;
  private startedTick?: number; private phase: Phase = 'request'; private offerIndex = 0; private offerRemaining = 0;
  constructor(params: TradeParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private fail(reason: string, retryable = false): BehaviourStatus { return { state: 'failed', reason, retryable }; }
  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot(); this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return this.fail('timeout', true);
    for (const event of ctx.pulseEvents) {
      if (event.type === 'trade-declined' && (event.data.entity === snapshot.self.entity || event.data.partner === snapshot.self.entity) && (event.data.entity === this.config.target || event.data.partner === this.config.target)) return this.fail(event.data.reason);
      if (event.type === 'trade-completed' && ((event.data.a === snapshot.self.entity && event.data.b === this.config.target) || (event.data.b === snapshot.self.entity && event.data.a === this.config.target))) return { state: 'done', summary: `trade with entity#${this.config.target} completed` };
      if (event.type === 'trade-opened' && ((event.data.a === snapshot.self.entity && event.data.b === this.config.target) || (event.data.b === snapshot.self.entity && event.data.a === this.config.target))) this.phase = 'offer';
      if (event.type === 'trade-stage' && ((event.data.a === snapshot.self.entity && event.data.b === this.config.target) || (event.data.b === snapshot.self.entity && event.data.a === this.config.target))) this.phase = event.data.stage === 'confirm' ? 'confirm' : 'offer';
    }
    if (snapshot.trade?.partner === this.config.target) {
      if (snapshot.trade.stage === 'offer' && (this.phase === 'request' || this.phase === 'wait-open')) this.phase = 'offer';
      if (snapshot.trade.stage === 'confirm' && this.phase !== 'wait-done') this.phase = 'confirm';
    }
    if (this.phase === 'request') {
      const target = snapshot.nearby.find((entity) => entity.id === this.config.target && entity.kind === 'player');
      if (target === undefined) return this.fail('target not found', true);
      if (!adjacent(snapshot.self.at, target.at)) {
        if (initial || snapshot.self.activity.kind === 'idle') {
          const moved = await ctx.act({ type: this.config.run === true ? 'run' : 'walk', data: { dest: target.at } });
          if (!moved.ok && (moved.code === 'unreachable' || moved.code === 'invalid_destination')) return this.fail(moved.code);
        }
        return { state: 'running', note: 'walking to trade partner' };
      }
      const requested = await ctx.act({ type: 'trade-request', data: { target: this.config.target } });
      if (!requested.ok) return this.fail(requested.code ?? requested.message ?? 'trade-request rejected', requested.code === 'too_far');
      this.phase = 'wait-open'; return { state: 'running', note: 'waiting for reciprocal request' };
    }
    if (this.phase === 'wait-open') return { state: 'running', note: 'waiting for trade-opened' };
    if (this.phase === 'offer') {
      const offer = this.config.offer[this.offerIndex];
      if (offer === undefined) {
        const accepted = await ctx.act({ type: 'trade-accept', data: {} });
        if (!accepted.ok) return this.fail(accepted.code ?? accepted.message ?? 'trade-accept rejected');
        this.phase = 'wait-confirm'; return { state: 'running', note: 'offer accepted; waiting for confirm review' };
      }
      this.offerRemaining ||= offer.amount;
      const slot = [...snapshot.inventory].filter((entry) => entry.item === offer.item).sort((left, right) => left.slot - right.slot)[0];
      if (slot === undefined) return this.fail(`missing item#${offer.item}`);
      const chunk = Math.min(slot.amount, this.offerRemaining);
      const offered = await ctx.act({ type: 'trade-offer', data: { slot: slot.slot, amount: this.offerRemaining } });
      if (!offered.ok) return this.fail(offered.code ?? offered.message ?? 'trade-offer rejected');
      this.offerRemaining -= chunk;
      if (this.offerRemaining <= 0) { this.offerIndex++; this.offerRemaining = 0; }
      return { state: 'running', note: `offered ${this.offerIndex}/${this.config.offer.length} items` };
    }
    if (this.phase === 'wait-confirm') return { state: 'running', note: 'waiting for both offer accepts' };
    if (this.phase === 'confirm') {
      const accepted = await ctx.act({ type: 'trade-accept', data: {} });
      if (!accepted.ok) return this.fail(accepted.code ?? accepted.message ?? 'confirm rejected');
      this.phase = 'wait-done'; return { state: 'running', note: 'confirmed after re-check; waiting for completion' };
    }
    return { state: 'running', note: 'waiting for trade-completed' };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> { if ((why === 'replaced' || why === 'cancelled') && ctx.view.snapshot().trade?.partner === this.config.target) await ctx.act({ type: 'trade-decline', data: {} }); }
  describe(): string { return `trade entity#${this.config.target} ${this.phase} (${this.offerIndex}/${this.config.offer.length})`.slice(0, 80); }
}
export const TRADE: BehaviourDefinition = { id: 'trade', description: 'Request a player trade, escrow an item list, and accept both review stages.', paramsSchema: { type: 'object', required: ['target', 'offer'], additionalProperties: false, properties: { target: { type: 'integer', minimum: 1 }, offer: { type: 'array', items: { type: 'object', required: ['item', 'amount'], additionalProperties: false, properties: { item: { type: 'integer', minimum: 1 }, amount: { type: 'integer', minimum: 1 } } } }, run: { type: 'boolean' }, timeoutTicks: { type: 'integer', minimum: 1, default: 200 } } }, validate, create: (params) => new TradeBehaviour(params as unknown as TradeParams) };
