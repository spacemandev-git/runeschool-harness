import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface FamiliarKeeperParams { readonly pouch: number; readonly renewBeforeTicks?: number; readonly dismiss?: boolean; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.pouch)) errors.push({ path: 'pouch', message: 'must be a positive pouch item id' });
  if (value.renewBeforeTicks !== undefined && !positive(value.renewBeforeTicks)) errors.push({ path: 'renewBeforeTicks', message: 'must be a positive integer' });
  if (value.dismiss !== undefined && typeof value.dismiss !== 'boolean') errors.push({ path: 'dismiss', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class FamiliarKeeperBehaviour implements Behaviour {
  readonly id = 'familiar-keeper';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: FamiliarKeeperParams;
  private startedTick?: number;
  private expectedExpiry?: number;
  private lifetime?: number;
  private pending: 'summon' | 'renew' | 'dismiss' | undefined;

  constructor(params: FamiliarKeeperParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async send(ctx: ReflexContext, action: 'summon' | 'renew' | 'dismiss'): Promise<BehaviourStatus> {
    const outcome = await ctx.act({ type: 'summon', data: { action, ...(action === 'dismiss' ? {} : { item: this.config.pouch }) } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? `${action} rejected`, retryable: outcome.code === 'busy' || outcome.code === 'summoning_points' || outcome.code === 'no_familiar' };
    this.pending = action;
    if (action === 'renew' && this.lifetime !== undefined) {
      this.expectedExpiry = ctx.tick + this.lifetime;
      this.pending = undefined;
    }
    return { state: 'running', note: `${action} requested` };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 10_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'familiar-summoned' && event.data.entity === snapshot.self.entity) {
        this.lifetime = Math.max(1, event.data.expiresAt - event.tick);
        this.expectedExpiry = event.data.expiresAt;
        this.pending = undefined;
      }
      if (event.type === 'familiar-dismissed' && event.data.entity === snapshot.self.entity) {
        this.pending = undefined;
        this.expectedExpiry = undefined;
        if (this.config.dismiss === true) return { state: 'done', summary: 'familiar dismissed' };
      }
    }
    const familiar = snapshot.familiar;
    if (this.config.dismiss === true) {
      if (familiar === undefined && this.pending !== 'dismiss') return { state: 'done', summary: 'no familiar active' };
      return this.pending === 'dismiss' ? { state: 'running', note: 'waiting for dismissal' } : this.send(ctx, 'dismiss');
    }
    if (familiar === undefined && this.expectedExpiry === undefined) {
      return this.pending === 'summon' ? { state: 'running', note: 'waiting for familiar' } : this.send(ctx, 'summon');
    }
    if (familiar !== undefined && this.expectedExpiry === undefined) {
      this.expectedExpiry = familiar.expiresAt;
      this.lifetime ??= Math.max(1, familiar.expiresAt - ctx.tick);
    }
    if ((this.expectedExpiry ?? Number.POSITIVE_INFINITY) - ctx.tick <= (this.config.renewBeforeTicks ?? 100)) {
      return this.pending === 'renew' ? { state: 'running', note: 'waiting for renewal' } : this.send(ctx, 'renew');
    }
    return { state: 'running', note: initial ? 'familiar active' : `renew before tick ${(this.expectedExpiry ?? 0)}` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `familiar-keeper pouch#${this.config.pouch}${this.config.dismiss === true ? ' dismissing' : ''}`.slice(0, 80); }
}

export const FAMILIAR_KEEPER: BehaviourDefinition = {
  id: 'familiar-keeper', description: 'Summon a familiar, renew it shortly before expiry, or dismiss it on request.',
  paramsSchema: { type: 'object', required: ['pouch'], additionalProperties: false, properties: {
    pouch: { type: 'integer', minimum: 1 }, renewBeforeTicks: { type: 'integer', minimum: 1, default: 100 },
    dismiss: { type: 'boolean', default: false }, timeoutTicks: { type: 'integer', minimum: 1, default: 10000 }
  } },
  validate, create: (params) => new FamiliarKeeperBehaviour(params as unknown as FamiliarKeeperParams)
};
