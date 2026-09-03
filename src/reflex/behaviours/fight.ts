import type { JsonValue } from '#protocol';
import { SPELLBOOK, isEntitySpell, spellById } from '../../vendor/magic/index.ts';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';
import type { NearbyEntityView, WorldSnapshot } from '../../core/percept.ts';
import { adjacent } from '../geometry.ts';

interface FightParams {
  readonly target?: number; readonly name?: string; readonly radius?: number; readonly kills?: number;
  readonly untilHpBelow?: number; readonly maxTicks?: number; readonly spell?: string;
  readonly targetKind?: 'npc' | 'player' | 'any';
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (value.target !== undefined && (!Number.isSafeInteger(value.target) || (value.target as number) <= 0)) errors.push({ path: 'target', message: 'must be a positive integer' });
  if (value.name !== undefined && typeof value.name !== 'string') errors.push({ path: 'name', message: 'must be a string' });
  if (value.radius !== undefined && !validNum(value.radius)) errors.push({ path: 'radius', message: 'must be non-negative' });
  if (value.kills !== undefined && (!Number.isSafeInteger(value.kills) || (value.kills as number) <= 0)) errors.push({ path: 'kills', message: 'must be a positive integer' });
  if (value.untilHpBelow !== undefined && (!validNum(value.untilHpBelow) || (value.untilHpBelow as number) > 1)) errors.push({ path: 'untilHpBelow', message: 'must be between 0 and 1' });
  if (value.maxTicks !== undefined && (!Number.isSafeInteger(value.maxTicks) || (value.maxTicks as number) <= 0)) errors.push({ path: 'maxTicks', message: 'must be a positive integer' });
  if (value.targetKind !== undefined && !['npc', 'player', 'any'].includes(String(value.targetKind))) errors.push({ path: 'targetKind', message: 'unknown target kind' });
  if (value.spell !== undefined) {
    const spell = typeof value.spell === 'string' ? spellById(value.spell) : undefined;
    if (spell === undefined || !isEntitySpell(spell)) errors.push({ path: 'spell', message: 'must be an entity spell id' });
  }
  return { ok: errors.length === 0, errors };
}
const kindMatches = (v: NearbyEntityView, targetKind: FightParams['targetKind'] = 'npc'): boolean =>
  targetKind === 'any' || v.kind === targetKind;
const alive = (v: NearbyEntityView, targetKind: FightParams['targetKind']): boolean =>
  kindMatches(v, targetKind) && (v.hp === undefined || v.hp.current > 0);

class FightBehaviour implements Behaviour {
  readonly id = 'fight'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: FightParams;
  private started?: number; private target?: number; private kills = 0; private missing = 0; private idle = 0;
  constructor(params: FightParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  private pick(s: WorldSnapshot): NearbyEntityView | undefined {
    const radius = this.config.radius ?? 12;
    if (this.config.target !== undefined) return s.nearby.find((v) => v.id === this.config.target && alive(v, this.config.targetKind) && v.distance <= radius);
    return s.nearby.filter((v) => alive(v, this.config.targetKind) && v.distance <= radius && (this.config.name === undefined || (v.name ?? '').toLowerCase().includes(this.config.name.toLowerCase())))
      .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
  }
  private async engage(ctx: ReflexContext, target: NearbyEntityView): Promise<BehaviourStatus> {
    this.target = target.id; this.missing = 0;
    const selfAt = ctx.view.snapshot().self.at;
    const inReach = this.config.spell === undefined
      ? adjacent(selfAt, target.at)
      : selfAt.level === target.at.level
        && Math.max(Math.abs(selfAt.x - target.at.x), Math.abs(selfAt.z - target.at.z)) <= 10;
    if (!inReach) {
      const out = await ctx.act({ type: 'walk', data: { dest: target.at } });
      if (!out.ok && (out.code === 'unreachable' || out.code === 'invalid_destination')) return { state: 'failed', reason: out.code, retryable: false };
    } else if (this.config.spell === undefined) await ctx.act({ type: 'attack', data: { target: target.id } });
    else await ctx.act({ type: 'cast', data: { target: target.id, spell: this.config.spell } });
    return { state: 'running', note: `engaging ${target.id}` };
  }
  async start(ctx: ReflexContext): Promise<BehaviourStatus> { this.started = ctx.tick; const t = this.pick(ctx.view.snapshot()); if (t === undefined) { this.missing = 1; return { state: 'running', note: 'seeking target' }; } return this.engage(ctx, t); }
  async step(ctx: ReflexContext): Promise<BehaviourStatus> {
    const s = ctx.view.snapshot(); this.started ??= ctx.tick;
    if (ctx.pulseEvents.some((e) => e.type === 'died' && e.data.entity === s.self.entity)) return { state: 'failed', reason: 'self died', retryable: false };
    if (this.config.maxTicks !== undefined && ctx.tick - this.started >= this.config.maxTicks) return { state: 'failed', reason: 'max ticks elapsed', retryable: true };
    if (this.config.untilHpBelow !== undefined && s.self.hp.max > 0 && s.self.hp.current / s.self.hp.max < this.config.untilHpBelow) return { state: 'done', summary: `hp below ${this.config.untilHpBelow}` };
    if (this.target !== undefined && ctx.pulseEvents.some((e) => e.type === 'died' && e.data.entity === this.target)) { this.kills++; this.target = undefined; this.idle = 0; }
    if (this.config.kills !== undefined && this.kills >= this.config.kills) return { state: 'done', summary: `${this.kills} kills` };
    let target = this.target === undefined ? undefined : s.nearby.find((v) => v.id === this.target && alive(v, this.config.targetKind));
    if (target === undefined) { target = this.pick(s); if (target === undefined) return ++this.missing >= 10 ? { state: 'failed', reason: 'no target in radius', retryable: true } : { state: 'running', note: 'seeking target' }; return this.engage(ctx, target); }
    const inReach = this.config.spell === undefined
      ? adjacent(s.self.at, target.at)
      : s.self.at.level === target.at.level
        && Math.max(Math.abs(s.self.at.x - target.at.x), Math.abs(s.self.at.z - target.at.z)) <= 10;
    if (!inReach) return this.engage(ctx, target);
    if (s.self.combat.target === target.id) this.idle = 0;
    else if (++this.idle >= 2) {
      this.idle = 0;
      if (this.config.spell === undefined) await ctx.act({ type: 'attack', data: { target: target.id } });
      else await ctx.act({ type: 'cast', data: { target: target.id, spell: this.config.spell } });
    }
    return { state: 'running', note: `${this.kills} kills` };
  }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `fight ${this.target ?? this.config.name ?? 'nearest'} (${this.kills}/${this.config.kills ?? '∞'} kills)`.slice(0, 80); }
}

export const FIGHT: BehaviourDefinition = {
  id: 'fight', description: 'Fight nearby NPCs or players until a kill or health condition is met.',
  paramsSchema: { type: 'object', properties: { target: { type: 'number' }, name: { type: 'string' }, targetKind: { type: 'string', enum: ['npc', 'player', 'any'], default: 'npc' }, radius: { type: 'number', default: 12 }, kills: { type: 'number' }, untilHpBelow: { type: 'number' }, maxTicks: { type: 'number' }, spell: { type: 'string', enum: SPELLBOOK.filter(isEntitySpell).map((spell) => spell.id) } } },
  validate, create: (params) => new FightBehaviour(params as FightParams)
};
