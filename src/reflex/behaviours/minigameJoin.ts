import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface MinigameJoinParams { readonly game: string; readonly options?: Readonly<Record<string, JsonValue>>; readonly timeoutTicks?: number; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.game !== 'string' || value.game.trim() === '') errors.push({ path: 'game', message: 'must be a non-empty game id' });
  if (value.options !== undefined && !object(value.options)) errors.push({ path: 'options', message: 'must be an object' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class MinigameJoinBehaviour implements Behaviour {
  readonly id = 'minigame-join';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: MinigameJoinParams;
  private startedTick?: number;
  private joined = false;
  private ready = false;
  private session?: string;

  constructor(params: MinigameJoinParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async command(ctx: ReflexContext, action: 'join' | 'ready'): Promise<BehaviourStatus> {
    const outcome = await ctx.act({ type: 'minigame', data: {
      action, game: this.config.game, ...(action === 'join' && this.config.options !== undefined ? { options: this.config.options } : {})
    } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? `${action} rejected`, retryable: outcome.code === 'not_ready' || outcome.code === 'no_lobby' };
    if (action === 'join') this.joined = true; else this.ready = true;
    return { state: 'running', note: `${action} sent for ${this.config.game}` };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const self = ctx.view.snapshot().self.entity;
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 5_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    for (const event of ctx.pulseEvents) {
      if (event.type === 'minigame-started' && event.data.game === this.config.game
        && event.data.players.includes(self)) this.session = event.data.session;
      if (event.type === 'minigame-ended' && event.data.game === this.config.game
        && (this.session === undefined || event.data.session === this.session)) {
        const won = event.data.winner === self;
        ctx.wakeMind('reflex-fired', `${this.config.game} ended${won ? ' with a win' : ''}.`);
        return { state: 'done', summary: `${this.config.game} ended${won ? '; won' : ''}` };
      }
      if (event.type === 'died' && event.data.entity === self && this.session === undefined) {
        return { state: 'failed', reason: 'self died before minigame start', retryable: false };
      }
      if (event.type === 'minigame-lobby' && event.data.game === this.config.game) {
        const player = event.data.players.find((entry) => entry.entity === self);
        if (player !== undefined) {
          this.joined = true;
          this.ready = player.ready || event.data.state === 'running';
        }
      }
    }
    if (initial && !this.joined) return this.command(ctx, 'join');
    if (this.session !== undefined) return { state: 'running', note: `${this.config.game} session ${this.session}` };
    if (this.joined && !this.ready) return this.command(ctx, 'ready');
    return { state: 'running', note: this.ready ? 'ready; waiting for start' : 'waiting for lobby' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {
    if ((why === 'replaced' || why === 'cancelled') && this.joined) {
      await ctx.act({ type: 'minigame', data: { action: 'leave', game: this.config.game } });
    }
  }
  describe(): string { return `minigame-join ${this.config.game} ${this.session ?? (this.ready ? 'ready' : 'lobby')}`.slice(0, 80); }
}

export const MINIGAME_JOIN: BehaviourDefinition = {
  id: 'minigame-join', description: 'Join and ready in a minigame lobby, then report the session result.',
  paramsSchema: { type: 'object', required: ['game'], additionalProperties: false, properties: {
    game: { type: 'string', minLength: 1 }, options: { type: 'object' },
    timeoutTicks: { type: 'integer', minimum: 1, default: 5000 }
  } },
  validate, create: (params) => new MinigameJoinBehaviour(params as unknown as MinigameJoinParams)
};
