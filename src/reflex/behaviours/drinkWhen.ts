import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface DrinkWhenParams {
  readonly potion: string;
  readonly hpBelow?: number;
  readonly prayerBelow?: number;
  readonly whenPoisoned?: boolean;
  readonly timeoutTicks?: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fraction = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.potion !== 'string' || value.potion.trim().length === 0) errors.push({ path: 'potion', message: 'must be a non-empty potion name' });
  if (value.hpBelow !== undefined && !fraction(value.hpBelow)) errors.push({ path: 'hpBelow', message: 'must be between 0 and 1' });
  if (value.prayerBelow !== undefined && !fraction(value.prayerBelow)) errors.push({ path: 'prayerBelow', message: 'must be between 0 and 1' });
  if (value.whenPoisoned !== undefined && typeof value.whenPoisoned !== 'boolean') errors.push({ path: 'whenPoisoned', message: 'must be boolean' });
  if (value.hpBelow === undefined && value.prayerBelow === undefined && value.whenPoisoned !== true) errors.push({ path: 'params', message: 'requires hpBelow, prayerBelow, or whenPoisoned:true' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class DrinkWhenBehaviour implements Behaviour {
  readonly id = 'drink-when';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: DrinkWhenParams;
  private startedTick?: number;
  private sentItem?: number;

  constructor(params: DrinkWhenParams) {
    this.config = params;
    this.params = params as unknown as Readonly<Record<string, JsonValue>>;
  }

  private triggered(ctx: ReflexContext): string | undefined {
    const self = ctx.view.snapshot().self;
    if (this.config.whenPoisoned === true && self.status?.poison !== undefined) return 'poisoned';
    if (this.config.hpBelow !== undefined && self.hp.max > 0
      && self.hp.current / self.hp.max < this.config.hpBelow) return 'low hp';
    if (this.config.prayerBelow !== undefined && self.prayer !== undefined && self.prayer.maxPoints > 0
      && self.prayer.points / self.prayer.maxPoints < this.config.prayerBelow) return 'low prayer';
    return undefined;
  }

  private async drive(ctx: ReflexContext, _initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return { state: 'failed', reason: 'timeout', retryable: true };
    if (this.sentItem !== undefined && ctx.pulseEvents.some((event) =>
      event.type === 'drank' && event.data.entity === snapshot.self.entity && event.data.item === this.sentItem)) {
      return { state: 'done', summary: `drank ${this.config.potion}` };
    }
    const reason = this.triggered(ctx);
    if (reason === undefined) return { state: 'running', note: 'waiting for threshold' };
    if (this.sentItem !== undefined) return { state: 'running', note: `waiting for ${this.config.potion} drink` };
    const needle = this.config.potion.toLowerCase();
    const potion = [...snapshot.inventory]
      .filter((entry) => (entry.name ?? '').toLowerCase().includes(needle))
      .sort((left, right) => left.slot - right.slot)[0];
    if (potion === undefined) return { state: 'failed', reason: `missing potion: ${this.config.potion}`, retryable: true };
    const outcome = await ctx.act({ type: 'drink', data: { item: potion.item } });
    if (!outcome.ok) {
      if (outcome.code === 'busy') return { state: 'running', note: 'drink cooldown busy' };
      return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'drink rejected', retryable: outcome.code === 'missing_item' };
    }
    this.sentItem = potion.item;
    return { state: 'running', note: `drinking for ${reason}` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `drink-when ${this.config.potion}${this.sentItem === undefined ? ' waiting' : ' sent'}`.slice(0, 80); }
}

export const DRINK_WHEN: BehaviourDefinition = {
  id: 'drink-when',
  description: 'Drink a named potion when HP, prayer, or poison state meets a configured trigger.',
  paramsSchema: {
    type: 'object', required: ['potion'], additionalProperties: false,
    properties: {
      potion: { type: 'string', minLength: 1 }, hpBelow: { type: 'number', minimum: 0, maximum: 1 },
      prayerBelow: { type: 'number', minimum: 0, maximum: 1 }, whenPoisoned: { type: 'boolean' },
      timeoutTicks: { type: 'integer', minimum: 1, default: 200 }
    }
  },
  validate,
  create: (params) => new DrinkWhenBehaviour(params as unknown as DrinkWhenParams)
};
