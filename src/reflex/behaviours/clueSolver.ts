import type { JsonValue, TileCoord } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

type ClueKind = 'map' | 'coordinate' | 'anagram' | 'emote' | 'cryptic';
interface ClueStep { readonly tier: 'easy' | 'medium' | 'hard'; readonly step: number; readonly kind: ClueKind; readonly text: string; }
interface ClueSolverParams {
  readonly item?: number;
  readonly locations?: Readonly<Record<string, TileCoord>>;
  readonly emotes?: Readonly<Record<string, string>>;
  readonly answers?: Readonly<Record<string, string>>;
  /** NPC name to live entity ID; cryptics talk to the matched NPC, then submit its name. */
  readonly npcs?: Readonly<Record<string, number>>;
  readonly run?: boolean;
  readonly timeoutTicks?: number;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const tile = (value: unknown): value is TileCoord => object(value)
  && ['x', 'z', 'level'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));

function stringMap(value: unknown): boolean {
  return object(value) && Object.values(value).every((entry) => typeof entry === 'string' && entry.trim() !== '');
}
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (value.item !== undefined && !positive(value.item)) errors.push({ path: 'item', message: 'must be a positive item id' });
  if (value.locations !== undefined && (!object(value.locations) || !Object.values(value.locations).every(tile))) errors.push({ path: 'locations', message: 'must map clue text to tiles' });
  if (value.emotes !== undefined && !stringMap(value.emotes)) errors.push({ path: 'emotes', message: 'must map clue text to emote names' });
  if (value.answers !== undefined && !stringMap(value.answers)) errors.push({ path: 'answers', message: 'must map clue text to answers' });
  if (value.npcs !== undefined && (!object(value.npcs) || !Object.values(value.npcs).every(positive))) errors.push({ path: 'npcs', message: 'must map NPC names to positive entity ids' });
  if (value.run !== undefined && typeof value.run !== 'boolean') errors.push({ path: 'run', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

function matched<T>(values: Readonly<Record<string, T>> | undefined, step: ClueStep): [string, T] | undefined {
  if (values === undefined) return undefined;
  const entries = Object.entries(values);
  const exact = entries.find(([key]) => key === step.text || key === `${step.tier}:${step.step}`);
  if (exact !== undefined) return exact;
  const text = step.text.toLowerCase();
  return entries.find(([key]) => text.includes(key.toLowerCase())) ?? (entries.length === 1 ? entries[0] : undefined);
}
function sameTile(left: TileCoord, right: TileCoord): boolean {
  return left.x === right.x && left.z === right.z && left.level === right.level;
}

class ClueSolverBehaviour implements Behaviour {
  readonly id = 'clue-solver';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: ClueSolverParams;
  private startedTick?: number;
  private currentStep?: ClueStep;
  private actedStep?: string;
  private talkedStep?: string;
  private readAt?: number;

  constructor(params: ClueSolverParams) {
    this.config = params;
    this.params = params as unknown as Readonly<Record<string, JsonValue>>;
  }

  private key(step: ClueStep): string { return `${step.tier}:${step.step}:${step.text}`; }
  private async act(ctx: ReflexContext, type: string, data: Readonly<Record<string, unknown>>, retryable = false): Promise<BehaviourStatus> {
    const outcome = await ctx.act({ type, data });
    return outcome.ok
      ? { state: 'running', note: `${type} sent for clue step ${this.currentStep?.step ?? '?'}` }
      : { state: 'failed', reason: outcome.code ?? outcome.message ?? `${type} rejected`, retryable };
  }

  private async solve(ctx: ReflexContext, step: ClueStep): Promise<BehaviourStatus> {
    const key = this.key(step);
    if (this.actedStep === key) return { state: 'running', note: `waiting for clue step ${step.step} to advance` };
    if (step.kind === 'map' || step.kind === 'coordinate' || step.kind === 'emote') {
      const destination = matched(this.config.locations, step)?.[1];
      if (destination === undefined) return { state: 'failed', reason: `no location configured for clue: ${step.text}`, retryable: false };
      if (!sameTile(ctx.view.snapshot().self.at, destination)) {
        return this.act(ctx, this.config.run === true ? 'run' : 'walk', { dest: destination }, true);
      }
      if (step.kind === 'emote') {
        const emote = matched(this.config.emotes, step)?.[1];
        if (emote === undefined) return { state: 'failed', reason: `no emote configured for clue: ${step.text}`, retryable: false };
        this.actedStep = key;
        return this.act(ctx, 'clue', { action: 'emote', emote });
      }
      this.actedStep = key;
      return this.act(ctx, 'clue', { action: 'dig' });
    }
    if (step.kind === 'cryptic') {
      const npc = matched(this.config.npcs, step);
      if (npc === undefined) return { state: 'failed', reason: `no NPC configured for clue: ${step.text}`, retryable: false };
      if (this.talkedStep !== key) {
        this.talkedStep = key;
        return this.act(ctx, 'talk-to', { npc: npc[1] }, true);
      }
      this.actedStep = key;
      return this.act(ctx, 'clue', { action: 'answer', answer: matched(this.config.answers, step)?.[1] ?? npc[0] });
    }
    const answer = matched(this.config.answers, step)?.[1];
    if (answer === undefined) return { state: 'failed', reason: `no answer configured for clue: ${step.text}`, retryable: false };
    this.actedStep = key;
    return this.act(ctx, 'clue', { action: 'answer', answer });
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 500)) return { state: 'failed', reason: 'timeout', retryable: true };
    const self = ctx.view.entity;
    for (const event of ctx.pulseEvents) {
      if (event.type === 'clue-complete' && event.data.entity === self) return { state: 'done', summary: `${event.data.tier} clue complete` };
      if (event.type === 'clue-step' && event.data.entity === self) {
        this.currentStep = event.data;
        this.readAt = undefined;
      }
      if (event.type === 'clue-advanced' && event.data.entity === self) {
        this.currentStep = undefined;
        this.actedStep = undefined;
        this.talkedStep = undefined;
      }
    }
    this.currentStep ??= ctx.view.snapshot().clue;
    if (this.currentStep !== undefined) return this.solve(ctx, this.currentStep);
    if (this.readAt === undefined) {
      this.readAt = ctx.tick;
      return this.act(ctx, 'clue', { action: 'read', ...(this.config.item === undefined ? {} : { item: this.config.item }) });
    }
    if (!initial && ctx.tick > this.readAt) {
      this.readAt = ctx.tick;
      return this.act(ctx, 'clue', { action: 'open-casket' });
    }
    return { state: 'running', note: 'waiting for clue text' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `clue-solver ${this.currentStep === undefined ? 'reading' : `${this.currentStep.kind} step ${this.currentStep.step}`}`.slice(0, 80); }
}

const tileSchema = { type: 'object', required: ['x', 'z', 'level'], additionalProperties: false, properties: {
  x: { type: 'number' }, z: { type: 'number' }, level: { type: 'number' }
} } as const;
export const CLUE_SOLVER: BehaviourDefinition = {
  id: 'clue-solver',
  description: 'Read and solve configured clue locations, emotes, answers, and cryptic NPC steps.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {
    item: { type: 'integer', minimum: 1 }, locations: { type: 'object', additionalProperties: tileSchema },
    emotes: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
    answers: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
    npcs: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
    run: { type: 'boolean', default: false }, timeoutTicks: { type: 'integer', minimum: 1, default: 500 }
  } },
  validate,
  create: (params) => new ClueSolverBehaviour(params as unknown as ClueSolverParams)
};
