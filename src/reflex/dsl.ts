import { ACTOR_COMMAND_TYPES } from '#protocol';
import type { SimEvent } from '#protocol';
import { isEntitySpell, spellById } from '../vendor/magic/index.ts';
import type { Expr, RefPath, Rule, RuleAction, ValidationResult } from '../core/reflex.ts';
import type { WorldSnapshot } from '../core/percept.ts';
import { isFood } from './tables.ts';

const REF_PATHS = [
  'self.hp.current', 'self.hp.max', 'self.hp.fraction', 'self.prayer.points',
  'self.prayer.fraction', 'self.inCombat', 'self.attackedBy.count', 'self.dead',
  'self.bound', 'self.autocast',
  'self.activity', 'self.at.x', 'self.at.z', 'self.at.level', 'inventory.free',
  'inventory.used', 'nearby.npcs.count', 'nearby.players.count', 'groundItems.count',
  'dialogue.active', 'dialogue.hasOptions', 'objectives.won', 'objectives.lost', 'tick'
] as const satisfies readonly RefPath[];
const REF_SET: ReadonlySet<string> = new Set(REF_PATHS);
const ACTOR_SET: ReadonlySet<string> = new Set(ACTOR_COMMAND_TYPES);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const BOOLEAN_REFS: ReadonlySet<RefPath> = new Set(['self.inCombat', 'self.dead', 'dialogue.active', 'dialogue.hasOptions', 'objectives.won', 'objectives.lost']);
const STRING_REFS: ReadonlySet<RefPath> = new Set(['self.activity', 'self.autocast']);

type ErrorEntry = { path: string; message: string };
const result = (errors: ErrorEntry[]): ValidationResult => ({ ok: errors.length === 0, errors });
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNegative = (v: unknown): v is number => finite(v) && v >= 0;
const positiveInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

function push(errors: ErrorEntry[], path: string, message: string): void { errors.push({ path, message }); }
function validateJson(value: unknown, path: string, errors: ErrorEntry[], seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object') { push(errors, path, 'must be JSON-serialisable'); return; }
  if (seen.has(value)) { push(errors, path, 'must not contain cycles'); return; }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => validateJson(entry, `${path}.${index}`, errors, seen));
  else for (const [key, entry] of Object.entries(value)) validateJson(entry, `${path}.${key}`, errors, seen);
  seen.delete(value);
}

function validateExprAt(value: unknown, path: string, depth: number, errors: ErrorEntry[]): void {
  if (depth > 8) { push(errors, path, 'expression depth must not exceed 8'); return; }
  if (!record(value)) { push(errors, path, 'must be an expression object'); return; }
  const op = value.op;
  if (typeof op !== 'string') { push(errors, `${path}.op`, 'must be a string'); return; }
  if (op === 'true' || op === 'false' || op === 'has-food') return;
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(value.args) || value.args.length === 0) push(errors, `${path}.args`, 'must be a non-empty array');
    else value.args.forEach((arg, index) => validateExprAt(arg, `${path}.args.${index}`, depth + 1, errors));
    return;
  }
  if (op === 'not') { validateExprAt(value.arg, `${path}.arg`, depth + 1, errors); return; }
  if (['lt', 'le', 'gt', 'ge', 'eq', 'ne'].includes(op)) {
    if (typeof value.ref !== 'string' || !REF_SET.has(value.ref)) push(errors, `${path}.ref`, 'unknown RefPath');
    if (!['number', 'string', 'boolean'].includes(typeof value.value) || (typeof value.value === 'number' && !Number.isFinite(value.value)))
      push(errors, `${path}.value`, 'must be a finite number, string, or boolean');
    else if (typeof value.ref === 'string' && REF_SET.has(value.ref)) {
      const expected = BOOLEAN_REFS.has(value.ref as RefPath) ? 'boolean' : STRING_REFS.has(value.ref as RefPath) ? 'string' : 'number';
      if (typeof value.value !== expected) push(errors, `${path}.value`, `must be ${expected} for ${value.ref}`);
      if (expected === 'boolean' && ['lt', 'le', 'gt', 'ge'].includes(op)) push(errors, `${path}.op`, 'ordering is not valid for booleans');
    }
    return;
  }
  if (op === 'has-item') {
    if (!(typeof value.item === 'string' && value.item.length > 0) && !(Number.isSafeInteger(value.item) && (value.item as number) > 0)) push(errors, `${path}.item`, 'must be a positive item id or non-empty name');
    if (value.min !== undefined && !nonNegative(value.min)) push(errors, `${path}.min`, 'must be a non-negative finite number');
    return;
  }
  if (op === 'skill-at-least') {
    if (typeof value.skill !== 'string' || value.skill.length === 0) push(errors, `${path}.skill`, 'must be a non-empty string');
    if (!nonNegative(value.level)) push(errors, `${path}.level`, 'must be a non-negative finite number');
    return;
  }
  if (op === 'nearby') {
    if (!['npc', 'player', 'ground_item', 'node', 'station'].includes(String(value.kind))) push(errors, `${path}.kind`, 'unknown nearby kind');
    if (value.name !== undefined && typeof value.name !== 'string') push(errors, `${path}.name`, 'must be a string');
    if (value.radius !== undefined && !nonNegative(value.radius)) push(errors, `${path}.radius`, 'must be non-negative');
    if (value.min !== undefined && !nonNegative(value.min)) push(errors, `${path}.min`, 'must be non-negative');
    return;
  }
  if (op === 'event') {
    if (typeof value.type !== 'string' || value.type.length === 0) push(errors, `${path}.type`, 'must be a non-empty string');
    if (value.withinTicks !== undefined && (!Number.isSafeInteger(value.withinTicks) || (value.withinTicks as number) < 0)) push(errors, `${path}.withinTicks`, 'must be a non-negative integer');
    return;
  }
  if (op === 'behaviour-running') {
    if (value.id !== undefined && typeof value.id !== 'string') push(errors, `${path}.id`, 'must be a string');
    return;
  }
  push(errors, `${path}.op`, `unknown op '${op}'`);
}

export function validateExpr(expr: unknown): ValidationResult {
  const errors: ErrorEntry[] = [];
  try { validateExprAt(expr, 'when', 1, errors); } catch { push(errors, 'when', 'invalid expression'); }
  return result(errors);
}

function validateTile(value: unknown, path: string, errors: ErrorEntry[]): void {
  if (!record(value)) { push(errors, path, 'must be a tile object'); return; }
  for (const key of ['x', 'z', 'level']) if (!finite(value[key])) push(errors, `${path}.${key}`, 'must be finite');
}

function validateAction(action: unknown, path: string, known: ReadonlySet<string>, errors: ErrorEntry[]): void {
  if (!record(action) || typeof action.kind !== 'string') { push(errors, path, 'must be a rule action object'); return; }
  switch (action.kind) {
    case 'command':
      if (typeof action.type !== 'string' || !ACTOR_SET.has(action.type)) push(errors, `${path}.type`, 'must be a non-admin actor command type');
      if (!record(action.data)) push(errors, `${path}.data`, 'must be an object');
      else validateJson(action.data, `${path}.data`, errors);
      break;
    case 'eat': if (action.prefer !== undefined && !['highest-heal', 'lowest-heal'].includes(String(action.prefer))) push(errors, `${path}.prefer`, 'unknown preference'); break;
    case 'attack-nearest':
      if (action.name !== undefined && typeof action.name !== 'string') push(errors, `${path}.name`, 'must be a string');
      if (action.radius !== undefined && !nonNegative(action.radius)) push(errors, `${path}.radius`, 'must be non-negative');
      if (action.targetKind !== undefined && !['npc', 'player', 'any'].includes(String(action.targetKind))) push(errors, `${path}.targetKind`, 'unknown target kind');
      break;
    case 'pickup-nearest':
      if (action.name !== undefined && typeof action.name !== 'string') push(errors, `${path}.name`, 'must be a string');
      if (action.radius !== undefined && !nonNegative(action.radius)) push(errors, `${path}.radius`, 'must be non-negative');
      break;
    case 'cast': {
      const spell = typeof action.spell === 'string' ? spellById(action.spell) : undefined;
      if (spell === undefined || !isEntitySpell(spell)) push(errors, `${path}.spell`, 'must be an entity spell id');
      if (action.target !== undefined && !['attacker', 'nearest', 'current'].includes(String(action.target))) {
        push(errors, `${path}.target`, 'unknown cast target selector');
      }
      if (action.name !== undefined && typeof action.name !== 'string') push(errors, `${path}.name`, 'must be a string');
      if (action.radius !== undefined && !nonNegative(action.radius)) push(errors, `${path}.radius`, 'must be non-negative');
      if (action.targetKind !== undefined && !['npc', 'player', 'any'].includes(String(action.targetKind))) push(errors, `${path}.targetKind`, 'unknown target kind');
      else if (action.targetKind !== undefined && action.target !== 'nearest') push(errors, `${path}.targetKind`, 'is only valid for nearest targets');
      break;
    }
    case 'teleport': {
      const spell = typeof action.spell === 'string' ? spellById(action.spell) : undefined;
      if (spell?.kind !== 'teleport') push(errors, `${path}.spell`, 'must be a teleport spell id');
      break;
    }
    case 'retaliate': case 'disengage': case 'bury-all': break;
    case 'flee':
      if (action.to !== undefined) validateTile(action.to, `${path}.to`, errors);
      if (action.distance !== undefined && !nonNegative(action.distance)) push(errors, `${path}.distance`, 'must be non-negative');
      break;
    case 'pray': if (typeof action.prayer !== 'string' || action.prayer.length === 0) push(errors, `${path}.prayer`, 'must be a non-empty string'); break;
    case 'start-behaviour':
      if (typeof action.behaviour !== 'string' || !known.has(action.behaviour)) push(errors, `${path}.behaviour`, 'unknown behaviour');
      if (!record(action.params)) push(errors, `${path}.params`, 'must be an object');
      else validateJson(action.params, `${path}.params`, errors);
      if (action.replace !== undefined && typeof action.replace !== 'boolean') push(errors, `${path}.replace`, 'must be boolean');
      break;
    case 'stop-behaviour': if (action.id !== undefined && typeof action.id !== 'string') push(errors, `${path}.id`, 'must be a string'); break;
    case 'wake-mind': if (typeof action.note !== 'string') push(errors, `${path}.note`, 'must be a string'); break;
    case 'note': if (typeof action.text !== 'string') push(errors, `${path}.text`, 'must be a string'); break;
    default: push(errors, `${path}.kind`, `unknown action '${action.kind}'`);
  }
}

export function validateRule(rule: unknown, knownBehaviours: ReadonlySet<string> = new Set()): ValidationResult {
  const errors: ErrorEntry[] = [];
  try {
    if (!record(rule)) return result([{ path: 'rule', message: 'must be an object' }]);
    if (typeof rule.id !== 'string' || !ID_RE.test(rule.id)) push(errors, 'id', 'must match ^[a-z0-9][a-z0-9-]{0,47}$');
    if (!finite(rule.priority)) push(errors, 'priority', 'must be finite');
    validateExprAt(rule.when, 'when', 1, errors);
    if (!Array.isArray(rule.do) || rule.do.length === 0) push(errors, 'do', 'must be a non-empty array');
    else rule.do.forEach((action, index) => validateAction(action, `do.${index}`, knownBehaviours, errors));
    if (rule.description !== undefined && typeof rule.description !== 'string') push(errors, 'description', 'must be a string');
    if (rule.cooldownTicks !== undefined && (!Number.isSafeInteger(rule.cooldownTicks) || (rule.cooldownTicks as number) < 0)) push(errors, 'cooldownTicks', 'must be a non-negative integer');
    if (rule.once !== undefined && typeof rule.once !== 'boolean') push(errors, 'once', 'must be boolean');
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') push(errors, 'enabled', 'must be boolean');
  } catch { push(errors, 'rule', 'invalid rule'); }
  return result(errors);
}

export function resolveRef(path: RefPath, s: WorldSnapshot): number | string | boolean {
  switch (path) {
    case 'self.hp.current': return s.self.hp.current;
    case 'self.hp.max': return s.self.hp.max;
    case 'self.hp.fraction': return s.self.hp.max === 0 ? 0 : s.self.hp.current / s.self.hp.max;
    case 'self.prayer.points': return s.self.prayer?.points ?? 0;
    case 'self.prayer.fraction': return s.self.prayer === undefined || s.self.prayer.maxPoints === 0 ? 0 : s.self.prayer.points / s.self.prayer.maxPoints;
    case 'self.inCombat': return s.self.combat.inCombat;
    case 'self.attackedBy.count': return s.self.combat.attackedBy.length;
    case 'self.dead': return s.self.dead;
    case 'self.bound': return s.self.combat.bound ? 1 : 0;
    case 'self.autocast': return s.self.combat.style?.spell ?? '';
    case 'self.activity': return s.self.activity.kind;
    case 'self.at.x': return s.self.at.x;
    case 'self.at.z': return s.self.at.z;
    case 'self.at.level': return s.self.at.level;
    case 'inventory.free': return s.inventoryFree;
    case 'inventory.used': return 28 - s.inventoryFree;
    case 'nearby.npcs.count': return s.nearby.filter((e) => e.kind === 'npc' && (e.hp === undefined || e.hp.current > 0)).length;
    case 'nearby.players.count': return s.nearby.filter((e) => e.kind === 'player' && e.id !== s.self.entity).length;
    case 'groundItems.count': return s.groundItems.length;
    case 'dialogue.active': return s.dialogue.active;
    case 'dialogue.hasOptions': return (s.dialogue.options?.length ?? 0) > 0;
    case 'objectives.won': return s.won;
    case 'objectives.lost': return s.lost;
    case 'tick': return s.tick;
  }
}

const includes = (value: string | undefined, query: string | undefined): boolean => query === undefined || (value ?? '').toLowerCase().includes(query.toLowerCase());

export function evaluate(expr: Expr, s: WorldSnapshot, recentEvents: readonly SimEvent[], engine: { behaviourRunning(id?: string): boolean }): boolean {
  switch (expr.op) {
    case 'true': return true;
    case 'false': return false;
    case 'and': return expr.args.every((arg) => evaluate(arg, s, recentEvents, engine));
    case 'or': return expr.args.some((arg) => evaluate(arg, s, recentEvents, engine));
    case 'not': return !evaluate(expr.arg, s, recentEvents, engine);
    case 'eq': { const left = resolveRef(expr.ref, s); return typeof left === typeof expr.value && left === expr.value; }
    case 'ne': { const left = resolveRef(expr.ref, s); return typeof left === typeof expr.value && left !== expr.value; }
    case 'lt': case 'le': case 'gt': case 'ge': {
      const left = resolveRef(expr.ref, s);
      if (typeof left !== typeof expr.value || (typeof left !== 'number' && typeof left !== 'string')) return false;
      const comparison = typeof left === 'number' ? left - (expr.value as number) : left.localeCompare(expr.value as string);
      if (expr.op === 'lt') return comparison < 0;
      if (expr.op === 'le') return comparison <= 0;
      if (expr.op === 'gt') return comparison > 0;
      return comparison >= 0;
    }
    case 'has-item': {
      const amount = s.inventory.filter((slot) => typeof expr.item === 'number' ? slot.item === expr.item : includes(slot.name, expr.item)).reduce((sum, slot) => sum + slot.amount, 0);
      return amount >= (expr.min ?? 1);
    }
    case 'has-food': return s.inventory.some((slot) => isFood(slot.item));
    case 'skill-at-least': {
      const found = Object.entries(s.skills).find(([name]) => name.toLowerCase() === expr.skill.toLowerCase());
      return (found?.[1].level ?? -1) >= expr.level;
    }
    case 'nearby': {
      const radius = expr.radius ?? s.radius;
      let count = 0;
      if (expr.kind === 'node') count = s.nodes.filter((v) => v.distance <= radius && includes(v.name, expr.name)).length;
      else if (expr.kind === 'station') count = s.stations.filter((v) => v.distance <= radius && includes(v.name, expr.name)).length;
      else if (expr.kind === 'ground_item') count = s.groundItems.filter((v) => v.distance <= radius && includes(v.name, expr.name)).length;
      else count = s.nearby.filter((v) => v.kind === expr.kind && (expr.kind !== 'player' || v.id !== s.self.entity) && v.distance <= radius && includes(v.name, expr.name)).length;
      return count >= (expr.min ?? 1);
    }
    case 'event': return recentEvents.some((event) => event.type === expr.type && event.tick >= s.tick - (expr.withinTicks ?? 1));
    case 'behaviour-running': return engine.behaviourRunning(expr.id);
  }
}

export type { RuleAction };
