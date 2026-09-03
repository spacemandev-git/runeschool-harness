import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { chebyshev } from '../geometry.ts';

export interface BankRunParams {
  readonly bankAt: TileCoord;
  readonly deposit: 'all' | 'none' | { readonly names: readonly string[] } | { readonly items: readonly number[] };
  readonly withdraw?: readonly { readonly item: number; readonly amount: number }[];
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (!obj(value.bankAt) || !['x', 'z', 'level'].every((key) => typeof (value.bankAt as Record<string, unknown>)[key] === 'number' && Number.isFinite((value.bankAt as Record<string, unknown>)[key]))) errors.push({ path: 'bankAt', message: 'must be a finite tile' });
  if (value.deposit !== 'all' && value.deposit !== 'none' && !obj(value.deposit)) errors.push({ path: 'deposit', message: 'must be all, none, names, or items' });
  else if (obj(value.deposit)) {
    const validNames = Array.isArray(value.deposit.names) && value.deposit.names.every((v) => typeof v === 'string');
    const validItems = Array.isArray(value.deposit.items) && value.deposit.items.every((v) => Number.isSafeInteger(v) && v > 0);
    if (validNames === validItems) errors.push({ path: 'deposit', message: 'must contain exactly one of names or items' });
  }
  if (value.withdraw !== undefined && (!Array.isArray(value.withdraw) || value.withdraw.some((v) => !obj(v) || !Number.isSafeInteger(v.item) || (v.item as number) <= 0 || !Number.isSafeInteger(v.amount) || (v.amount as number) <= 0))) errors.push({ path: 'withdraw', message: 'must contain positive item/amount entries' });
  return { ok: errors.length === 0, errors };
}

export class BankRunBehaviour implements Behaviour {
  readonly id = 'bank-run'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: BankRunParams; private deposited = new Set<number>(); private withdrawIndex = 0; private phase: 'walk' | 'deposit' | 'withdraw' = 'walk';
  constructor(params: BankRunParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private matches(item: { item: number; name?: string }): boolean {
    if (this.config.deposit === 'all') return true;
    if (this.config.deposit === 'none') return false;
    if ('items' in this.config.deposit) return this.config.deposit.items.includes(item.item);
    return this.config.deposit.names.some((name) => (item.name ?? '').toLowerCase().includes(name.toLowerCase()));
  }
  private async run(ctx: ReflexContext): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot();
    if (chebyshev(s.self.at, this.config.bankAt) > 2) { this.phase = 'walk'; const out = await ctx.act({ type: 'walk', data: { dest: this.config.bankAt } }); return !out.ok && (out.code === 'unreachable' || out.code === 'invalid_destination') ? { state: 'failed', reason: out.code, retryable: false } : { state: 'running', note: 'walking to bank' }; }
    this.phase = 'deposit';
    const stack = s.inventory.filter((v) => this.matches(v) && !this.deposited.has(v.slot)).sort((a, b) => a.slot - b.slot)[0];
    if (stack !== undefined) {
      const amount = s.inventory.filter((v) => v.item === stack.item).reduce((sum, v) => sum + v.amount, 0);
      const out = await ctx.act({ type: 'bank-deposit', data: { item: stack.item, amount } });
      if (!out.ok && out.code === 'no_bank_nearby') return { state: 'failed', reason: 'no_bank_nearby', retryable: false };
      if (out.ok) this.deposited.add(stack.slot);
      return { state: 'running', note: `depositing ${stack.item}` };
    }
    this.phase = 'withdraw';
    const withdrawal = this.config.withdraw?.[this.withdrawIndex];
    if (withdrawal !== undefined) {
      const out = await ctx.act({ type: 'bank-withdraw', data: { item: withdrawal.item, amount: withdrawal.amount } });
      if (!out.ok && out.code === 'no_bank_nearby') return { state: 'failed', reason: 'no_bank_nearby', retryable: false };
      if (out.ok) this.withdrawIndex++;
      return { state: 'running', note: `withdrawing ${withdrawal.item}` };
    }
    return { state: 'done', summary: 'bank run complete' };
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.run(ctx); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.run(ctx); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `bank-run (${this.config.bankAt.x},${this.config.bankAt.z},${this.config.bankAt.level}) ${this.phase}`.slice(0, 80); }
}
export const BANK_RUN: BehaviourDefinition = { id: 'bank-run', description: 'Walk to a bank, deposit inventory, and withdraw supplies.', paramsSchema: { type: 'object', required: ['bankAt', 'deposit'], properties: { bankAt: { type: 'object' }, deposit: { oneOf: [{ enum: ['all', 'none'] }, { type: 'object' }] }, withdraw: { type: 'array', items: { type: 'object' } } } }, validate, create: (params) => new BankRunBehaviour(params as unknown as BankRunParams) };
