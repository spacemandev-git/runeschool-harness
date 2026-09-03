import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface MinigameLoopParams {
  readonly game: string;
  readonly options?: Readonly<Record<string, JsonValue>>;
  readonly rounds?: number;
  readonly timeoutTicks?: number;
}
const BARROWS_SARCOPHAGI = new Set([6821, 6771, 6773, 6822, 6772, 6823]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.game !== 'string' || value.game.trim() === '') errors.push({ path: 'game', message: 'must be a non-empty game id' });
  if (value.options !== undefined && !object(value.options)) errors.push({ path: 'options', message: 'must be an object' });
  if (value.rounds !== undefined && !positive(value.rounds)) errors.push({ path: 'rounds', message: 'must be a positive integer' });
  if (value.timeoutTicks !== undefined && !positive(value.timeoutTicks)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

class MinigameLoopBehaviour implements Behaviour {
  readonly id = 'minigame-loop';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: MinigameLoopParams;
  private startedTick?: number;
  private joined = false;
  private ready = false;
  private session?: string;
  private rounds = 0;
  private barrowsSearchPending = false;
  constructor(params: MinigameLoopParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async minigame(ctx: ReflexContext, action: 'join' | 'ready'): Promise<BehaviourStatus> {
    const outcome = await ctx.act({ type: 'minigame', data: {
      action, game: this.config.game,
      ...(action === 'join' && this.config.options !== undefined ? { options: this.config.options } : {})
    } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? `${action} rejected`, retryable: outcome.code === 'no_lobby' || outcome.code === 'not_ready' };
    if (action === 'join') this.joined = true; else this.ready = true;
    return { state: 'running', note: `${action} sent for ${this.config.game}` };
  }

  private async searchBarrows(ctx: ReflexContext): Promise<BehaviourStatus> {
    const sarcophagus = ctx.view.snapshot().nearby
      .filter((entity) => entity.kind === 'loc' && entity.loc !== undefined && BARROWS_SARCOPHAGI.has(entity.loc))
      .sort((left, right) => left.distance - right.distance || left.id - right.id)[0];
    if (sarcophagus === undefined || sarcophagus.loc === undefined) return { state: 'running', note: 'seeking a Barrows sarcophagus' };
    if (sarcophagus.distance > 1) {
      const walk = await ctx.act({ type: 'walk', data: { dest: sarcophagus.at } });
      if (!walk.ok) return { state: 'failed', reason: walk.code ?? walk.message ?? 'walk rejected', retryable: true };
      return { state: 'running', note: 'walking to Barrows sarcophagus' };
    }
    const outcome = await ctx.act({ type: 'interact', data: {
      target: { kind: 'loc', at: sarcophagus.at, loc: sarcophagus.loc }, option: 'Search'
    } });
    if (!outcome.ok) return { state: 'failed', reason: outcome.code ?? outcome.message ?? 'search rejected', retryable: outcome.code === 'too_far' };
    this.barrowsSearchPending = false;
    return { state: 'running', note: 'searched Barrows sarcophagus' };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 10_000)) return { state: 'failed', reason: 'timeout', retryable: true };
    const self = ctx.view.entity;
    for (const event of ctx.pulseEvents) {
      if (event.type === 'minigame-lobby' && event.data.game === this.config.game) {
        const player = event.data.players.find((entry) => entry.entity === self);
        if (player !== undefined) { this.joined = true; this.ready = player.ready || event.data.state === 'running'; }
      }
      if (event.type === 'minigame-started' && event.data.game === this.config.game && event.data.players.includes(self)) {
        this.session = event.data.session;
      }
      if (event.type === 'minigame-ended' && event.data.game === this.config.game
        && (this.session === undefined || event.data.session === this.session)) {
        this.rounds++;
        if (this.config.rounds !== undefined && this.rounds >= this.config.rounds) {
          return { state: 'done', summary: `${this.config.game}: ${this.rounds} rounds complete` };
        }
        this.joined = false; this.ready = false; this.session = undefined; this.barrowsSearchPending = false;
      }
      if (event.type !== 'minigame-event' || event.data.game !== this.config.game
        || (this.session !== undefined && event.data.session !== this.session)) continue;
      if (this.config.game === 'pest-control' && event.data.kind === 'portal-shield-dropped'
        && object(event.data.data) && positive(event.data.data.entity)) {
        const outcome = await ctx.act({ type: 'attack', data: { target: event.data.data.entity } });
        return outcome.ok
          ? { state: 'running', note: `attacking Pest Control portal entity#${event.data.data.entity}` }
          : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'portal attack rejected', retryable: outcome.code === 'unknown_entity' };
      }
      if (this.config.game === 'barrows'
        && (event.data.kind === 'crypt-entered' || event.data.kind === 'brother-killed' || event.data.kind === 'sarcophagus-empty')) {
        this.barrowsSearchPending = true;
      }
    }
    if (this.barrowsSearchPending) return this.searchBarrows(ctx);
    if (!this.joined) return this.minigame(ctx, 'join');
    if (this.session !== undefined) return { state: 'running', note: `${this.config.game} session ${this.session}; ${this.rounds} rounds complete` };
    if (!this.ready) return this.minigame(ctx, 'ready');
    return { state: 'running', note: initial ? 'joined; waiting for lobby' : 'ready; waiting for start' };
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {
    if ((why === 'replaced' || why === 'cancelled') && this.joined) await ctx.act({ type: 'minigame', data: { action: 'leave', game: this.config.game } });
  }
  describe(): string { return `minigame-loop ${this.config.game} ${this.rounds}/${this.config.rounds ?? '∞'} rounds`.slice(0, 80); }
}

export const MINIGAME_LOOP: BehaviourDefinition = {
  id: 'minigame-loop', description: 'Repeatedly join a game and react to Pest Control portals or Barrows sarcophagi.',
  paramsSchema: { type: 'object', required: ['game'], additionalProperties: false, properties: {
    game: { type: 'string', minLength: 1 }, options: { type: 'object' },
    rounds: { type: 'integer', minimum: 1 }, timeoutTicks: { type: 'integer', minimum: 1, default: 10000 }
  } },
  validate, create: (params) => new MinigameLoopBehaviour(params as unknown as MinigameLoopParams)
};
