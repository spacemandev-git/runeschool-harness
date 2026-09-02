import type { JsonValue } from '#protocol';
import type { ActionIntent, ActionOutcome } from '../core/actions.ts';
import type { HarnessBus } from '../core/bus.ts';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ReflexEngine, ReflexEngineState, Rule, ValidationResult } from '../core/reflex.ts';
import { evaluate, validateRule } from './dsl.ts';
import { BUILTIN_BEHAVIOURS } from './behaviours/index.ts';
import { planRuleAction } from './ruleActions.ts';

interface RuleEntry { rule: Rule; lastFiredTick?: number; fireCount: number; enabled: boolean; }
interface Instance { instance: string; id: string; params: Readonly<Record<string, JsonValue>>; behaviour: Behaviour; startedTick: number; started: boolean; queuedDuringPulse: boolean; }

export interface ExtensibleReflexEngine extends ReflexEngine {
  /** Add or replace a behaviour definition for future starts. Running instances are unaffected. */
  registerDefinition(definition: BehaviourDefinition): boolean;
  /** Remove a definition for future starts. Running and queued instances are unaffected. */
  unregisterDefinition(id: string): boolean;
}

export function createReflexEngine(options: { agentId: string; bus?: HarnessBus; definitions?: readonly BehaviourDefinition[]; maxActionsPerPulse?: number }): ExtensibleReflexEngine {
  const definitions = options.definitions ?? BUILTIN_BEHAVIOURS;
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const rules = new Map<string, RuleEntry>();
  const queue: Instance[] = [];
  let active: Instance | undefined;
  let nextInstance = 0;
  let lastContext: ReflexContext | undefined;
  let lastTick = 0;
  let inPulse = false;

  const info = (entry: Instance) => ({ instance: entry.instance, id: entry.id, params: entry.params, startedTick: entry.startedTick, description: safeDescribe(entry.behaviour) });
  const state = (): ReflexEngineState => ({
    rules: [...rules.values()].map((entry) => ({ ...entry.rule, enabled: entry.enabled, ...(entry.lastFiredTick === undefined ? {} : { lastFiredTick: entry.lastFiredTick }), fireCount: entry.fireCount })).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    ...(active === undefined ? {} : { behaviour: info(active) }), queue: queue.map(info)
  });
  const emit = (line: string): void => { options.bus?.emit('agent.reflex', { agentId: options.agentId, line, state: state() }); };
  const logChange = (ctx: ReflexContext | undefined, line: string): void => { try { ctx?.log(line); } catch {} emit(line); };

  function safeDescribe(behaviour: Behaviour): string {
    try { return behaviour.describe().replace(/[\r\n]+/g, ' ').slice(0, 80); } catch { return behaviour.id; }
  }
  function promote(): void { if (active === undefined) active = queue.shift(); }
  async function stopEntry(entry: Instance, ctx: ReflexContext, why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {
    try { await entry.behaviour.stop(behaviourContext(ctx, entry, { used: 0 }, Number.POSITIVE_INFINITY), why); } catch (error) { try { ctx.log(`${entry.instance} stop threw: ${String(error)}`); } catch {} }
  }
  function behaviourRunning(id?: string): boolean { return active !== undefined && (id === undefined || active.id === id || active.instance === id) || queue.some((entry) => id === undefined || entry.id === id || entry.instance === id); }
  function cappedAct(ctx: ReflexContext, source: ActionIntent['source'], counter: { used: number }, limit: number): ReflexContext['act'] {
    return async (intent) => {
      const full: ActionIntent = { ...intent, source };
      if (counter.used >= limit) return { intent: full, ok: false, code: 'pulse_action_limit', message: 'pulse action limit reached', tick: ctx.tick, sentAt: 0 };
      counter.used++;
      return (ctx.act as unknown as (intent: ActionIntent) => Promise<ActionOutcome>)(full);
    };
  }
  function wrappedContext(ctx: ReflexContext, source: ActionIntent['source'], counter: { used: number }, limit: number): ReflexContext {
    return { agentId: ctx.agentId, view: ctx.view, tick: ctx.tick, pulseEvents: ctx.pulseEvents, act: cappedAct(ctx, source, counter, limit), wakeMind: (reason, note) => ctx.wakeMind(reason, note), log: (line) => ctx.log(line) };
  }
  function behaviourContext(ctx: ReflexContext, entry: Instance, counter: { used: number }, limit: number): ReflexContext { return wrappedContext(ctx, { kind: 'behaviour', id: entry.id, instance: entry.instance }, counter, limit); }

  const engine: ExtensibleReflexEngine = {
    installRule(rule): ValidationResult {
      const validation = validateRule(rule, new Set(byId.keys()));
      if (!validation.ok) return validation;
      rules.set(rule.id, { rule: { ...rule }, fireCount: 0, enabled: rule.enabled ?? true });
      return validation;
    },
    removeRule(id): boolean { return rules.delete(id); },
    setRuleEnabled(id, enabled): boolean { const entry = rules.get(id); if (entry === undefined) return false; entry.enabled = enabled; return true; },
    listBehaviours(): readonly BehaviourDefinition[] { return [...byId.values()]; },
    registerDefinition(definition): boolean {
      byId.set(definition.id, definition);
      return true;
    },
    unregisterDefinition(id): boolean { return byId.delete(id); },
    async startBehaviour(id, params, startOptions = {}) {
      const definition = byId.get(id);
      if (definition === undefined) return { ok: false, errors: [{ path: 'behaviour', message: `unknown behaviour '${id}'` }] };
      let validation: ValidationResult;
      try { validation = definition.validate(params); } catch (error) { return { ok: false, errors: [{ path: 'params', message: `validation threw: ${String(error)}` }] }; }
      if (!validation.ok) return { ok: false, errors: validation.errors };
      let behaviour: Behaviour;
      try { behaviour = definition.create(params); } catch (error) { return { ok: false, errors: [{ path: 'params', message: `creation threw: ${String(error)}` }] }; }
      const entry: Instance = { instance: `${id}#${++nextInstance}`, id, params, behaviour, startedTick: lastTick, started: false, queuedDuringPulse: inPulse };
      if (startOptions.replace === true && active !== undefined) {
        const replaced = active; active = undefined;
        if (lastContext !== undefined) await stopEntry(replaced, lastContext, 'replaced');
        logChange(lastContext, `${replaced.instance} replaced`);
        queue.unshift(entry); promote();
      } else if (active === undefined) active = entry;
      else queue.push(entry);
      logChange(lastContext, `${entry.instance} queued`);
      return { ok: true, instance: entry.instance };
    },
    async stopBehaviour(instance) {
      if (active !== undefined && (instance === undefined || active.instance === instance || active.id === instance)) {
        const stopped = active; active = undefined;
        if (lastContext !== undefined) await stopEntry(stopped, lastContext, 'cancelled');
        logChange(lastContext, `${stopped.instance} cancelled`); promote(); return true;
      }
      const index = queue.findIndex((entry) => instance === undefined || entry.instance === instance || entry.id === instance);
      if (index < 0) return false;
      const [stopped] = queue.splice(index, 1); logChange(lastContext, `${stopped!.instance} cancelled`); return true;
    },
    state,
    async pulse(ctx): Promise<void> {
      try {
        inPulse = true;
        lastContext = ctx; lastTick = ctx.tick;
        const counter = { used: 0 }; const limit = options.maxActionsPerPulse ?? 3;
        let snapshot;
        try { snapshot = ctx.view.snapshot(); } catch (error) { try { ctx.log(`reflex snapshot failed: ${String(error)}`); } catch {} return; }
        const ordered = [...rules.values()].sort((a, b) => b.rule.priority - a.rule.priority || a.rule.id.localeCompare(b.rule.id));
        for (const entry of ordered) {
          if (counter.used >= limit) break;
          const cooldown = entry.rule.cooldownTicks ?? 1;
          if (!entry.enabled || (entry.lastFiredTick !== undefined && ctx.tick - entry.lastFiredTick < cooldown)) continue;
          let matches = false;
          try { matches = evaluate(entry.rule.when, snapshot, ctx.pulseEvents, { behaviourRunning }); } catch (error) { try { ctx.log(`rule ${entry.rule.id} evaluation failed: ${String(error)}`); } catch {} }
          if (!matches) continue;
          const ruleCtx = wrappedContext(ctx, { kind: 'reflex', id: entry.rule.id }, counter, limit);
          const actionCtx = { ...ruleCtx, engine };
          for (const action of entry.rule.do) {
            if (counter.used >= limit) break;
            try { await planRuleAction(action, snapshot, actionCtx); } catch (error) { try { ctx.log(`rule ${entry.rule.id} action failed: ${String(error)}`); } catch {} }
          }
          entry.lastFiredTick = ctx.tick; entry.fireCount++; if (entry.rule.once === true) entry.enabled = false;
          logChange(ctx, `rule ${entry.rule.id} fired`);
        }
        promote();
        const current = active;
        if (current === undefined) return;
        if (current.queuedDuringPulse) { current.queuedDuringPulse = false; return; }
        const behaviourCtx = behaviourContext(ctx, current, counter, limit);
        let status: BehaviourStatus;
        try {
          if (!current.started) { current.started = true; current.startedTick = ctx.tick; status = await current.behaviour.start(behaviourCtx); logChange(ctx, `${current.instance} started`); }
          else status = await current.behaviour.step(behaviourCtx);
        } catch (error) { status = { state: 'failed', reason: String(error), retryable: false }; }
        if (status.state === 'running') return;
        await stopEntry(current, ctx, status.state);
        if (active === current) active = undefined;
        const line = status.state === 'done' ? `${current.instance} done: ${status.summary}` : `${current.instance} failed: ${status.reason}`;
        logChange(ctx, line);
        try { ctx.wakeMind(status.state === 'done' ? 'behaviour-finished' : 'behaviour-failed', status.state === 'done' ? status.summary : status.reason); } catch {}
        promote();
      } catch (error) { try { ctx.log(`reflex pulse failed: ${String(error)}`); } catch {} }
      finally { inPulse = false; }
    }
  };
  return engine;
}
