import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface RandomEventParams {
  readonly preferredSkill?: string;
  readonly answers?: Readonly<Record<string, string | number>>;
  readonly fleeTiles?: number;
  readonly timeoutTicks?: number;
}
interface ActiveRandomEvent { readonly event: string; readonly prompt?: string; readonly options?: readonly string[]; }
const HOSTILE = new Set(['rock-golem', 'river-troll', 'tree-spirit', 'zombie', 'shade', 'swarm', 'strange-plant']);
const KNOWN_ANSWERS: Readonly<Record<string, string>> = Object.freeze({
  'mysterious-old-man': 'continue', 'sandwich-lady': 'baguette', 'quiz-master': 'pickaxe',
  'evil-bob': 'raw herring', 'drill-demon': 'jump,push-up,sit-up', 'frog-princess': 'frog princess',
  'surprise-exam': 'lobster', 'drunken-dwarf': 'accept', certer: 'first',
  'freaky-forester': 'two feathers', 'pious-pete': 'blue', pillory: 'square', 'rick-turpentine': 'accept'
});
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (value.preferredSkill !== undefined && (typeof value.preferredSkill !== 'string' || value.preferredSkill.trim() === '')) errors.push({ path: 'preferredSkill', message: 'must be a non-empty string' });
  if (value.answers !== undefined && (!object(value.answers) || Object.values(value.answers).some((answer) => typeof answer !== 'string' && !Number.isSafeInteger(answer)))) errors.push({ path: 'answers', message: 'must map event ids to answer strings or option indexes' });
  if (value.fleeTiles !== undefined && !positive(value.fleeTiles)) errors.push({ path: 'fleeTiles', message: 'must be a positive integer' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

function choiceFor(active: ActiveRandomEvent, config: RandomEventParams): { answer?: string; choice?: number } {
  const configured = config.answers?.[active.event];
  if (typeof configured === 'number') return { choice: configured };
  if (typeof configured === 'string') return { answer: configured };
  const options = active.options ?? [];
  if (active.event === 'genie') {
    const preferred = (config.preferredSkill ?? 'hitpoints').toLowerCase();
    const index = options.findIndex((option) => option.toLowerCase() === preferred);
    return { choice: index >= 0 ? index : 0 };
  }
  const known = KNOWN_ANSWERS[active.event];
  if (known !== undefined) {
    const index = options.findIndex((option) => option.trim().toLowerCase() === known);
    return index >= 0 ? { choice: index } : { answer: known };
  }
  const prompt = active.prompt?.toLowerCase() ?? '';
  const named = options.findIndex((option) => prompt.includes(option.toLowerCase()));
  return { choice: named >= 0 ? named : 0 };
}

class RandomEventResponderBehaviour implements Behaviour {
  readonly id = 'random-event-responder';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: RandomEventParams;
  private startedTick?: number;
  private handled?: string;
  constructor(params: RandomEventParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async handle(ctx: ReflexContext, active: ActiveRandomEvent): Promise<BehaviourStatus> {
    if (this.handled === active.event) return { state: 'running', note: `waiting for ${active.event} outcome` };
    this.handled = active.event;
    if (HOSTILE.has(active.event) || (active.options === undefined && /attack/i.test(active.prompt ?? ''))) {
      const dismissed = await ctx.act({ type: 'random-event', data: { action: 'dismiss' } });
      if (!dismissed.ok) return { state: 'failed', reason: dismissed.code ?? dismissed.message ?? 'dismiss rejected', retryable: dismissed.code === 'no_event' };
      const snapshot = ctx.view.snapshot();
      const dest = { ...snapshot.self.at, z: Math.max(0, snapshot.self.at.z - (this.config.fleeTiles ?? 10)) };
      const fled = await ctx.act({ type: 'run', data: { dest } });
      if (!fled.ok && fled.code === 'out_of_energy') await ctx.act({ type: 'walk', data: { dest } });
      return { state: 'running', note: `dismissed ${active.event}; fleeing ${this.config.fleeTiles ?? 10} tiles` };
    }
    const outcome = await ctx.act({ type: 'random-event', data: { action: 'respond', ...choiceFor(active, this.config) } });
    return outcome.ok
      ? { state: 'running', note: `answered ${active.event}` }
      : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'response rejected', retryable: outcome.code === 'no_event' };
  }

  private async drive(ctx: ReflexContext, _initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 100)) return { state: 'failed', reason: 'timeout', retryable: true };
    const self = ctx.view.entity;
    for (const event of ctx.pulseEvents) {
      if (event.type === 'random-event-ended' && event.data.entity === self && this.handled === event.data.event) {
        return { state: 'done', summary: `${event.data.event} ${event.data.outcome}` };
      }
    }
    const started = [...ctx.pulseEvents].reverse().find((event) => event.type === 'random-event-started' && event.data.entity === self);
    const active = started?.type === 'random-event-started' ? started.data : ctx.view.snapshot().randomEvent;
    return active === undefined ? { state: 'running', note: 'watching for a random event' } : this.handle(ctx, active);
  }
  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `random-event-responder ${this.handled === undefined ? 'watching' : `handling ${this.handled}`}`.slice(0, 80); }
}

export const RANDOM_EVENT_RESPONDER: BehaviourDefinition = {
  id: 'random-event-responder', description: 'Answer prompt random events and dismiss hostile events while fleeing ten tiles.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {
    preferredSkill: { type: 'string', default: 'hitpoints' },
    answers: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] } },
    fleeTiles: { type: 'integer', minimum: 1, default: 10 }, timeoutTicks: { type: 'integer', minimum: 1, default: 100 }
  } },
  validate, create: (params) => new RandomEventResponderBehaviour(params as unknown as RandomEventParams)
};
