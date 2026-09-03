import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface CourseLoopParams { readonly course: string; readonly obstacles: readonly number[]; readonly laps: number; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.course !== 'string' || value.course.trim() === '') errors.push({ path: 'course', message: 'must be a non-empty course id' });
  if (!Array.isArray(value.obstacles) || value.obstacles.length === 0
    || !value.obstacles.every((entry) => Number.isSafeInteger(entry) && entry >= 0)) {
    errors.push({ path: 'obstacles', message: 'must be a non-empty array of non-negative obstacle indexes' });
  }
  if (!positive(value.laps)) errors.push({ path: 'laps', message: 'must be a positive integer' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class CourseLoopBehaviour implements Behaviour {
  readonly id = 'course-loop';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: CourseLoopParams;
  private startedTick?: number;
  private obstacleIndex = 0;
  private laps = 0;
  private waiting = false;

  constructor(params: CourseLoopParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async traverse(ctx: ReflexContext): Promise<BehaviourStatus> {
    const obstacle = this.config.obstacles[this.obstacleIndex]!;
    const outcome = await ctx.act({ type: 'traverse', data: { course: this.config.course, obstacle } });
    if (!outcome.ok) {
      return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'traverse rejected', retryable: outcome.code === 'busy' };
    }
    this.waiting = true;
    return { state: 'running', note: `lap ${this.laps + 1}/${this.config.laps}, obstacle ${obstacle}` };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 2_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    const self = ctx.view.snapshot().self.entity;
    for (const event of ctx.pulseEvents) {
      if (event.type === 'died' && event.data.entity === self) return { state: 'failed', reason: 'self died', retryable: false };
      if ((event.type === 'obstacle-completed' || event.type === 'obstacle-failed')
        && event.data.entity === self && event.data.course === this.config.course
        && event.data.obstacle === this.config.obstacles[this.obstacleIndex]) {
        this.waiting = false;
        if (event.type === 'obstacle-completed') {
          this.obstacleIndex++;
          if (this.obstacleIndex === this.config.obstacles.length) {
            this.obstacleIndex = 0;
            this.laps++;
            if (this.laps >= this.config.laps) return { state: 'done', summary: `completed ${this.laps} ${this.config.course} laps` };
          }
        }
      }
    }
    if (initial || !this.waiting) return this.traverse(ctx);
    return { state: 'running', note: `lap ${this.laps + 1}/${this.config.laps} in progress` };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `course-loop ${this.config.course} lap ${this.laps + 1}/${this.config.laps}`.slice(0, 80); }
}

export const COURSE_LOOP: BehaviourDefinition = {
  id: 'course-loop', description: 'Traverse an ordered agility obstacle list for a fixed number of laps.',
  paramsSchema: { type: 'object', required: ['course', 'obstacles', 'laps'], additionalProperties: false, properties: {
    course: { type: 'string', minLength: 1 }, obstacles: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
    laps: { type: 'integer', minimum: 1 }, timeoutTicks: { type: 'integer', minimum: 1, default: 2000 }
  } },
  validate, create: (params) => new CourseLoopBehaviour(params as unknown as CourseLoopParams)
};
