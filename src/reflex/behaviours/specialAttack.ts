import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import { adjacent } from '../geometry.ts';

interface SpecialAttackParams { readonly target: number; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (!positive(value.target)) errors.push({ path: 'target', message: 'must be a positive entity id' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class SpecialAttackBehaviour implements Behaviour {
  readonly id = 'special-attack';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: SpecialAttackParams;
  private startedTick?: number;
  private sent = false;
  constructor(params: SpecialAttackParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 100)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'special-attack' && event.data.attacker === snapshot.self.entity
        && event.data.target === this.config.target) return { state: 'done', summary: `used ${event.data.special}` };
      if (event.type === 'died' && event.data.entity === snapshot.self.entity) return { state: 'failed', reason: 'self died', retryable: false };
      if (event.type === 'died' && event.data.entity === this.config.target) return { state: 'failed', reason: 'target died before special', retryable: true };
    }
    if (this.sent) return { state: 'running', note: 'waiting for special swing' };
    const target = snapshot.nearby.find((entry) => entry.id === this.config.target && entry.hp?.current !== 0);
    if (target === undefined) return { state: 'failed', reason: 'target not found', retryable: true };
    if (!adjacent(snapshot.self.at, target.at)) {
      if (initial || snapshot.self.activity.kind === 'idle') {
        const outcome = await ctx.act({ type: 'walk', data: { dest: target.at } });
        if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'walk rejected', retryable: outcome.code !== 'invalid_destination' };
      }
      return { state: 'running', note: 'walking into special range' };
    }
    const toggle = await ctx.act({ type: 'special', data: { enabled: true } });
    if (!toggle.ok) return { state: 'failed', reason: toggle.code ?? toggle.message ?? 'special rejected', retryable: toggle.code === 'special_energy' };
    const attack = await ctx.act({ type: 'attack', data: { target: this.config.target } });
    if (!attack.ok) return { state: 'failed', reason: attack.code ?? attack.message ?? 'attack rejected', retryable: attack.code === 'too_far' };
    this.sent = true;
    return { state: 'running', note: 'special toggled; waiting for swing' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {
    if (!this.sent && (why === 'replaced' || why === 'cancelled') && ctx.view.snapshot().self.status?.specialEnabled) {
      await ctx.act({ type: 'special', data: { enabled: false } });
    }
  }
  describe(): string { return `special-attack entity#${this.config.target} ${this.sent ? 'armed' : 'approaching'}`.slice(0, 80); }
}

export const SPECIAL_ATTACK: BehaviourDefinition = {
  id: 'special-attack', description: 'Walk adjacent, toggle the equipped weapon special, and attack once.',
  paramsSchema: { type: 'object', required: ['target'], additionalProperties: false, properties: { target: { type: 'integer', minimum: 1 }, timeoutTicks: { type: 'integer', minimum: 1, default: 100 } } },
  validate, create: (params) => new SpecialAttackBehaviour(params as unknown as SpecialAttackParams)
};
