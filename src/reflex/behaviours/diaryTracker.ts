import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface DiaryTrackerParams { readonly area?: string; readonly refreshTicks?: number; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (value.area !== undefined && (typeof value.area !== 'string' || value.area.trim() === '')) errors.push({ path: 'area', message: 'must be a non-empty area id' });
  if (value.refreshTicks !== undefined && !positive(value.refreshTicks)) errors.push({ path: 'refreshTicks', message: 'must be a positive integer' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class DiaryTrackerBehaviour implements Behaviour {
  readonly id = 'diary-tracker';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: DiaryTrackerParams;
  private startedTick?: number;
  private queriedTick?: number;
  private note?: string;
  constructor(params: DiaryTrackerParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async query(ctx: ReflexContext): Promise<BehaviourStatus> {
    this.queriedTick = ctx.tick;
    const outcome = await ctx.act({ type: 'diary', data: this.config.area === undefined ? {} : { area: this.config.area } });
    return outcome.ok
      ? { state: 'running', note: this.note ?? 'querying easy diary tasks' }
      : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'diary query rejected', retryable: outcome.code !== 'diary_locked' };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 5_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    const self = ctx.view.entity;
    const easy = ctx.pulseEvents.filter((event) => event.type === 'diary-progress'
      && event.data.entity === self && event.data.level === 'easy'
      && (this.config.area === undefined || event.data.area === this.config.area));
    for (const event of easy) {
      if (event.type !== 'diary-progress') continue;
      const next = event.data.tasks.find((task) => !task.done);
      if (next !== undefined) {
        const note = `Next easy diary task (${event.data.area}): ${next.text}`;
        if (note !== this.note) { this.note = note; ctx.wakeMind('reflex-fired', note); }
        return { state: 'running', note };
      }
    }
    if (easy.length > 0 && easy.every((event) => event.type === 'diary-progress' && event.data.done === event.data.total)) {
      return { state: 'done', summary: this.config.area === undefined ? 'all queried easy diaries complete' : `${this.config.area} easy diary complete` };
    }
    if (initial || this.queriedTick === undefined || ctx.tick - this.queriedTick >= (this.config.refreshTicks ?? 50)) return this.query(ctx);
    return { state: 'running', note: this.note ?? 'tracking easy diary tasks' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return (this.note ?? `diary-tracker ${this.config.area ?? 'all areas'}`).slice(0, 80); }
}

export const DIARY_TRACKER: BehaviourDefinition = {
  id: 'diary-tracker', description: 'Query achievement diaries and expose the next incomplete easy task as a goal note.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {
    area: { type: 'string', minLength: 1 }, refreshTicks: { type: 'integer', minimum: 1, default: 50 },
    timeoutTicks: { type: 'integer', minimum: 1, default: 5000 }
  } },
  validate, create: (params) => new DiaryTrackerBehaviour(params as unknown as DiaryTrackerParams)
};
