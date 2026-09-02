import type { SimEvent } from '#protocol';
import type { Expr, RefPath, Rule, RuleAction, ValidationResult } from '../core/reflex.ts';
import type { WorldSnapshot } from '../core/percept.ts';

const REF_PATHS = [
  'self.hp.current', 'self.hp.max', 'self.hp.fraction', 'self.prayer.points',
  'self.prayer.fraction', 'self.inCombat', 'self.attackedBy.count', 'self.dead',
  'self.bound', 'self.autocast', 'self.activity', 'self.at.x', 'self.at.z',
  'self.at.level', 'inventory.free', 'inventory.used', 'nearby.npcs.count',
  'nearby.players.count', 'groundItems.count', 'dialogue.active',
  'dialogue.hasOptions', 'objectives.won', 'objectives.lost', 'tick'
] as const satisfies readonly RefPath[];

const REF_SET: ReadonlySet<string> = new Set(REF_PATHS);
const BOOLEAN_REFS: ReadonlySet<RefPath> = new Set([
  'self.inCombat', 'self.dead', 'self.bound', 'dialogue.active',
  'dialogue.hasOptions', 'objectives.won', 'objectives.lost'
]);
const STRING_REFS: ReadonlySet<RefPath> = new Set(['self.activity', 'self.autocast']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
type ErrorEntry = { path: string; message: string };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;

function validateJson(value: unknown, path: string, errors: ErrorEntry[], seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
  if (typeof value !== 'object') { errors.push({ path, message: 'must be JSON-serialisable' }); return; }
  if (seen.has(value)) { errors.push({ path, message: 'must not contain cycles' }); return; }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => validateJson(entry, `${path}.${index}`, errors, seen));
  else for (const [key, entry] of Object.entries(value)) validateJson(entry, `${path}.${key}`, errors, seen);
  seen.delete(value);
}

function validateExprAt(value: unknown, path: string, depth: number, errors: ErrorEntry[]): void {
  if (depth > 8) { errors.push({ path, message: 'expression depth must not exceed 8' }); return; }
  if (!record(value) || typeof value.op !== 'string') { errors.push({ path, message: 'must be an expression object' }); return; }
  if (value.op === 'true' || value.op === 'false') return;
  if (value.op === 'and' || value.op === 'or') {
    if (!Array.isArray(value.args) || value.args.length === 0) errors.push({ path: `${path}.args`, message: 'must be a non-empty array' });
    else value.args.forEach((entry, index) => validateExprAt(entry, `${path}.args.${index}`, depth + 1, errors));
    return;
  }
  if (value.op === 'not') { validateExprAt(value.arg, `${path}.arg`, depth + 1, errors); return; }
  if (['lt', 'le', 'gt', 'ge', 'eq', 'ne'].includes(value.op)) {
    if (typeof value.ref !== 'string' || !REF_SET.has(value.ref)) errors.push({ path: `${path}.ref`, message: 'unknown RefPath' });
    const actual = typeof value.value;
    if (!['number', 'string', 'boolean'].includes(actual) || actual === 'number' && !finite(value.value)) {
      errors.push({ path: `${path}.value`, message: 'must be a finite number, string, or boolean' });
    } else if (typeof value.ref === 'string' && REF_SET.has(value.ref)) {
      const ref = value.ref as RefPath;
      const expected = BOOLEAN_REFS.has(ref) ? 'boolean' : STRING_REFS.has(ref) ? 'string' : 'number';
      if (actual !== expected) errors.push({ path: `${path}.value`, message: `must be ${expected} for ${ref}` });
    }
    return;
  }
  if (value.op === 'has-item') {
    if (!(typeof value.item === 'string' && value.item.length > 0) && !(Number.isSafeInteger(value.item) && (value.item as number) > 0)) {
      errors.push({ path: `${path}.item`, message: 'must be a positive item id or non-empty name' });
    }
    if (value.min !== undefined && !nonNegative(value.min)) errors.push({ path: `${path}.min`, message: 'must be non-negative' });
    return;
  }
  if (value.op === 'skill-at-least') {
    if (typeof value.skill !== 'string' || value.skill.length === 0) errors.push({ path: `${path}.skill`, message: 'must be a non-empty string' });
    if (!nonNegative(value.level)) errors.push({ path: `${path}.level`, message: 'must be non-negative' });
    return;
  }
  if (value.op === 'nearby') {
    if (!['npc', 'player', 'ground_item', 'node', 'station'].includes(String(value.kind))) errors.push({ path: `${path}.kind`, message: 'unknown nearby kind' });
    if (value.name !== undefined && typeof value.name !== 'string') errors.push({ path: `${path}.name`, message: 'must be a string' });
    if (value.radius !== undefined && !nonNegative(value.radius)) errors.push({ path: `${path}.radius`, message: 'must be non-negative' });
    if (value.min !== undefined && !nonNegative(value.min)) errors.push({ path: `${path}.min`, message: 'must be non-negative' });
    return;
  }
  if (value.op === 'event') {
    if (typeof value.type !== 'string' || value.type.length === 0) errors.push({ path: `${path}.type`, message: 'must be a non-empty string' });
    if (value.withinTicks !== undefined && (!Number.isSafeInteger(value.withinTicks) || (value.withinTicks as number) < 0)) errors.push({ path: `${path}.withinTicks`, message: 'must be a non-negative integer' });
    return;
  }
  if (value.op === 'behaviour-running') {
    if (value.id !== undefined && typeof value.id !== 'string') errors.push({ path: `${path}.id`, message: 'must be a string' });
    return;
  }
  errors.push({ path: `${path}.op`, message: `unknown op '${value.op}'` });
}

export function validateExpr(expr: unknown): ValidationResult {
  const errors: ErrorEntry[] = [];
  validateExprAt(expr, 'when', 1, errors);
  return { ok: errors.length === 0, errors };
}

function validateAction(action: unknown, path: string, known: ReadonlySet<string>, errors: ErrorEntry[]): void {
  if (!record(action) || typeof action.kind !== 'string') { errors.push({ path, message: 'must be a rule action object' }); return; }
  if (action.kind === 'command') {
    if (typeof action.type !== 'string' || action.type.length === 0) errors.push({ path: `${path}.type`, message: 'must be a non-empty adapter command' });
    if (!record(action.data)) errors.push({ path: `${path}.data`, message: 'must be an object' });
    else validateJson(action.data, `${path}.data`, errors);
    return;
  }
  if (action.kind === 'start-behaviour') {
    if (typeof action.behaviour !== 'string' || !known.has(action.behaviour)) errors.push({ path: `${path}.behaviour`, message: 'unknown behaviour' });
    if (!record(action.params)) errors.push({ path: `${path}.params`, message: 'must be an object' });
    return;
  }
  if (action.kind === 'stop-behaviour') {
    if (action.id !== undefined && typeof action.id !== 'string') errors.push({ path: `${path}.id`, message: 'must be a string' });
    return;
  }
  if (action.kind === 'wake-mind' || action.kind === 'note') {
    const key = action.kind === 'wake-mind' ? 'note' : 'text';
    if (typeof action[key] !== 'string' || action[key].length === 0) errors.push({ path: `${path}.${key}`, message: 'must be a non-empty string' });
    return;
  }
  errors.push({ path: `${path}.kind`, message: `unknown action '${action.kind}'` });
}

export function validateRule(rule: unknown, knownBehaviours: ReadonlySet<string> = new Set()): ValidationResult {
  const errors: ErrorEntry[] = [];
  if (!record(rule)) return { ok: false, errors: [{ path: 'rule', message: 'must be an object' }] };
  if (typeof rule.id !== 'string' || !ID_RE.test(rule.id)) errors.push({ path: 'id', message: `must match ${ID_RE.source}` });
  if (!finite(rule.priority)) errors.push({ path: 'priority', message: 'must be finite' });
  validateExprAt(rule.when, 'when', 1, errors);
  if (!Array.isArray(rule.do) || rule.do.length === 0) errors.push({ path: 'do', message: 'must be a non-empty array' });
  else rule.do.forEach((action, index) => validateAction(action, `do.${index}`, knownBehaviours, errors));
  if (rule.cooldownTicks !== undefined && (!Number.isSafeInteger(rule.cooldownTicks) || (rule.cooldownTicks as number) < 0)) errors.push({ path: 'cooldownTicks', message: 'must be a non-negative integer' });
  if (rule.once !== undefined && typeof rule.once !== 'boolean') errors.push({ path: 'once', message: 'must be boolean' });
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push({ path: 'enabled', message: 'must be boolean' });
  return { ok: errors.length === 0, errors };
}

export function resolveRef(ref: RefPath, snapshot: WorldSnapshot): number | string | boolean {
  switch (ref) {
    case 'self.hp.current': return snapshot.self.hp.current;
    case 'self.hp.max': return snapshot.self.hp.max;
    case 'self.hp.fraction': return snapshot.self.hp.max <= 0 ? 0 : snapshot.self.hp.current / snapshot.self.hp.max;
    case 'self.prayer.points': return snapshot.self.prayer?.points ?? 0;
    case 'self.prayer.fraction': return snapshot.self.prayer === undefined || snapshot.self.prayer.maxPoints <= 0 ? 0 : snapshot.self.prayer.points / snapshot.self.prayer.maxPoints;
    case 'self.inCombat': return snapshot.self.combat.inCombat;
    case 'self.attackedBy.count': return snapshot.self.combat.attackedBy.length;
    case 'self.dead': return snapshot.self.dead;
    case 'self.bound': return snapshot.self.combat.bound === true;
    case 'self.autocast': return typeof snapshot.self.combat.autocast === 'string' ? snapshot.self.combat.autocast : '';
    case 'self.activity': return snapshot.self.activity.kind;
    case 'self.at.x': return snapshot.self.at.x;
    case 'self.at.z': return snapshot.self.at.z;
    case 'self.at.level': return snapshot.self.at.level;
    case 'inventory.free': return snapshot.inventoryFree;
    case 'inventory.used': return snapshot.inventory.length;
    case 'nearby.npcs.count': return snapshot.nearby.filter((entry) => entry.kind === 'npc').length;
    case 'nearby.players.count': return snapshot.nearby.filter((entry) => entry.kind === 'player' && entry.id !== snapshot.self.entity).length;
    case 'groundItems.count': return snapshot.groundItems.length;
    case 'dialogue.active': return snapshot.dialogue.active;
    case 'dialogue.hasOptions': return (snapshot.dialogue.options?.length ?? 0) > 0;
    case 'objectives.won': return snapshot.won;
    case 'objectives.lost': return snapshot.lost;
    case 'tick': return snapshot.tick;
  }
}

const includes = (value: string | undefined, query: string | undefined): boolean =>
  query === undefined || (value ?? '').toLowerCase().includes(query.toLowerCase());

export function evaluate(expr: Expr, snapshot: WorldSnapshot, events: readonly SimEvent[], engine: { behaviourRunning(id?: string): boolean }): boolean {
  switch (expr.op) {
    case 'true': return true;
    case 'false': return false;
    case 'and': return expr.args.every((entry) => evaluate(entry, snapshot, events, engine));
    case 'or': return expr.args.some((entry) => evaluate(entry, snapshot, events, engine));
    case 'not': return !evaluate(expr.arg, snapshot, events, engine);
    case 'eq': { const left = resolveRef(expr.ref, snapshot); return typeof left === typeof expr.value && left === expr.value; }
    case 'ne': { const left = resolveRef(expr.ref, snapshot); return typeof left === typeof expr.value && left !== expr.value; }
    case 'lt': case 'le': case 'gt': case 'ge': {
      const left = resolveRef(expr.ref, snapshot);
      if (typeof left !== typeof expr.value || typeof left !== 'number') return false;
      if (expr.op === 'lt') return left < (expr.value as number);
      if (expr.op === 'le') return left <= (expr.value as number);
      if (expr.op === 'gt') return left > (expr.value as number);
      return left >= (expr.value as number);
    }
    case 'has-item': return snapshot.inventory
      .filter((slot) => typeof expr.item === 'number' ? slot.item === expr.item : includes(slot.name, expr.item))
      .reduce((sum, slot) => sum + slot.amount, 0) >= (expr.min ?? 1);
    case 'skill-at-least': return (Object.entries(snapshot.skills)
      .find(([name]) => name.toLowerCase() === expr.skill.toLowerCase())?.[1].level ?? -1) >= expr.level;
    case 'nearby': {
      const radius = expr.radius ?? snapshot.radius;
      const values = expr.kind === 'node' ? snapshot.nodes
        : expr.kind === 'station' ? snapshot.stations
          : expr.kind === 'ground_item' ? snapshot.groundItems
            : snapshot.nearby.filter((entry) => entry.kind === expr.kind && (expr.kind !== 'player' || entry.id !== snapshot.self.entity));
      return values.filter((entry) => entry.distance <= radius && includes(entry.name, expr.name)).length >= (expr.min ?? 1);
    }
    case 'event': return events.some((event) => event.type === expr.type && event.tick >= snapshot.tick - (expr.withinTicks ?? 1));
    case 'behaviour-running': return engine.behaviourRunning(expr.id);
  }
}

export type { RuleAction };
