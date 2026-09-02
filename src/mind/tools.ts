import type { JsonValue } from '#protocol';
import { AGENT_DENIED_COMMANDS } from '../core/actions.ts';
import type { MindDeps } from '../core/agent.ts';
import type { MemoryKind } from '../core/memory.ts';
import type { ToolDefinition } from '../core/model.ts';
import type { PromptName } from '../core/prompts.ts';
import type { ReflexEngineState, Rule } from '../core/reflex.ts';
import { PULSE_MILLIS } from '../core/reflex.ts';
import { renderDeltaLines, renderSnapshot } from '../format.ts';

export interface AgentTool {
  readonly definition: ToolDefinition;
  run(args: Record<string, unknown>): Promise<JsonValue>;
}

export interface AgentToolContext {
  endWake(): void;
  finish(success: boolean, summary: string): void;
  /** Internal cursor hooks used by the Mind; standalone callers may omit them. */
  getWakeCheckpoint?(): number;
  setWakeCheckpoint?(checkpoint: number): void;
  reflexChanged?(): void;
}

const MEMORY_KINDS = new Set<MemoryKind>(['episodic', 'semantic', 'spatial', 'procedural', 'journal']);
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonSafe(value: unknown): JsonValue {
  const encoded = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === 'bigint') return String(child);
    if (typeof child === 'number' && !Number.isFinite(child)) return String(child);
    if (typeof child === 'function' || typeof child === 'symbol' || child === undefined) return null;
    return child;
  });
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

function truncateResult(value: unknown): JsonValue {
  const safe = jsonSafe(value);
  const encoded = JSON.stringify(safe);
  if (encoded.length <= 4_000) return safe;
  let text = encoded.slice(0, 3_900);
  let result: JsonValue = { truncated: true, text };
  while (JSON.stringify(result).length > 4_000 && text.length > 0) {
    text = text.slice(0, Math.max(0, text.length - 100));
    result = { truncated: true, text };
  }
  return result;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, name);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function definition(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: readonly string[] = []
): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false
    }
  };
}

function total(toolDefinition: ToolDefinition, run: (args: Record<string, unknown>) => Promise<unknown> | unknown): AgentTool {
  return {
    definition: toolDefinition,
    async run(args): Promise<JsonValue> {
      try {
        return truncateResult(await run(args));
      } catch (error) {
        return truncateResult({ error: errorMessage(error) });
      }
    }
  };
}

export function compactReflexState(state: ReflexEngineState): JsonValue {
  return {
    rules: state.rules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      enabled: rule.enabled ?? true,
      fireCount: rule.fireCount
    })),
    behaviour: state.behaviour === undefined ? null : {
      id: state.behaviour.id,
      instance: state.behaviour.instance,
      description: state.behaviour.description
    },
    queue: state.queue.map((entry) => ({
      id: entry.id,
      instance: entry.instance,
      description: entry.description
    }))
  };
}

export function compactReflexText(state: ReflexEngineState): string {
  const compact = compactReflexState(state) as {
    readonly rules: readonly { readonly id: string; readonly priority: number; readonly enabled: boolean; readonly fireCount: number }[];
    readonly behaviour: null | { readonly id: string; readonly instance: string; readonly description: string };
    readonly queue: readonly { readonly id: string; readonly instance: string; readonly description: string }[];
  };
  const rules = compact.rules.length === 0 ? 'none' : compact.rules
    .map((rule) => `${rule.id} p${rule.priority} ${rule.enabled ? 'on' : 'off'} fired=${rule.fireCount}`).join('; ');
  const behaviour = compact.behaviour === null ? 'none'
    : `${compact.behaviour.instance}: ${compact.behaviour.description}`;
  const queue = compact.queue.length === 0 ? 'none' : compact.queue
    .map((entry) => `${entry.instance}: ${entry.description}`).join('; ');
  return `Rules: ${rules}\nBehaviour: ${behaviour}\nQueue: ${queue}`;
}

export function createAgentTools(deps: MindDeps, ctx: AgentToolContext): readonly AgentTool[] {
  let fallbackCheckpoint: number | undefined;
  const tools: AgentTool[] = [];
  const add = (tool: AgentTool): void => { tools.push(tool); };
  const denied = new Set([...AGENT_DENIED_COMMANDS, ...(deps.deniedCommandTypes ?? [])]);
  const allowedCommands = [...new Set(deps.commandTypes)].filter((type) => type.length > 0 && !denied.has(type));
  const guideNames = deps.prompts.list().filter((name) => !name.endsWith('-system'));

  add(total(definition('observe', 'Render a fresh compact world snapshot.', {}), () => ({
    text: renderSnapshot(deps.view.snapshot())
  })));

  add(total(definition('scan', 'Search the wider world by case-insensitive name, kind, id, or config id.', {
    query: { type: 'string' }
  }, ['query']), async (args) => deps.worldReads.scan(string(args.query, 'query'))));

  add(total(definition('act', `Submit one adapter command. Allowed types: ${allowedCommands.join(', ') || 'none'}`, {
    type: { type: 'string', enum: allowedCommands },
    data: { type: 'object' },
    reason: { type: 'string' }
  }, ['type', 'data']), async (args) => {
    const type = string(args.type, 'type');
    if (denied.has(type)) return { error: `Command '${type}' is denied to agents` };
    if (!allowedCommands.includes(type)) return { error: `Unknown or disallowed adapter command '${type}'` };
    const data = object(args.data, 'data');
    const reason = optionalString(args.reason, 'reason');
    const outcome = await deps.sink.submit({
      type,
      data,
      source: { kind: 'mind' },
      ...(reason === undefined ? {} : { reason })
    });
    const { source: _source, ...intent } = outcome.intent;
    return {
      intent,
      ok: outcome.ok,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      ...(outcome.details === undefined ? {} : { details: outcome.details }),
      tick: outcome.tick,
      sentAt: outcome.sentAt
    };
  }));

  add(total(definition('wait', 'Wait 1–20 adapter pulses, then render changes since the wake or previous wait.', {
    ticks: { type: 'integer', minimum: 1, maximum: 20, default: 2 }
  }), async (args) => {
    const ticks = args.ticks === undefined ? 2 : args.ticks;
    if (!Number.isInteger(ticks) || (ticks as number) < 1 || (ticks as number) > 20) {
      throw new Error('ticks must be an integer from 1 to 20');
    }
    const checkpoint = ctx.getWakeCheckpoint?.() ?? fallbackCheckpoint ?? deps.view.checkpoint();
    await new Promise<void>((resolve) => setTimeout(resolve, (ticks as number) * (deps.pulseMs ?? PULSE_MILLIS)));
    const snapshot = deps.view.snapshot();
    const lines = renderDeltaLines(deps.view.deltaSince(checkpoint), (kind, id) => deps.view.nameOf(kind, id));
    const next = deps.view.checkpoint();
    fallbackCheckpoint = next;
    ctx.setWakeCheckpoint?.(next);
    return { lines, tick: snapshot.tick };
  }));

  const behaviours = deps.reflexes.listBehaviours();
  const catalogue = behaviours.map((entry) => `${entry.id} — ${entry.description}`).join('\n');
  add(total(definition('install_rule', "Install or replace a validated reflex rule. The DSL uses a closed {id, priority, when, do, cooldownTicks?, once?, enabled?} shape; expressions inspect documented refs and actions issue commands, behaviours, or wakes. Call guide('reflex-authoring') for the complete grammar.", {
    rule: { type: 'object' }
  }, ['rule']), (args) => {
    const result = deps.reflexes.installRule(object(args.rule, 'rule') as unknown as Rule);
    if (result.ok) ctx.reflexChanged?.();
    return result;
  }));

  add(total(definition('remove_rule', 'Remove a reflex rule by id.', {
    id: { type: 'string' }
  }, ['id']), (args) => {
    const removed = deps.reflexes.removeRule(string(args.id, 'id'));
    if (removed) ctx.reflexChanged?.();
    return removed;
  }));

  add(total(definition('list_reflexes', 'List compact reflex rules, active behaviour, and queued behaviours.', {}), () =>
    compactReflexState(deps.reflexes.state())));

  add(total(definition('start_behaviour', `Start or queue a deterministic multi-tick behaviour.\n${catalogue}`, {
    behaviour: { type: 'string', enum: behaviours.map((entry) => entry.id) },
    params: { type: 'object' },
    replace: { type: 'boolean' }
  }, ['behaviour', 'params']), async (args) => {
    const behaviour = string(args.behaviour, 'behaviour');
    const params = object(args.params, 'params') as Record<string, JsonValue>;
    const replace = args.replace === undefined ? undefined : boolean(args.replace, 'replace');
    const result = await deps.reflexes.startBehaviour(behaviour, params, replace === undefined ? undefined : { replace });
    if (result.ok) ctx.reflexChanged?.();
    return result;
  }));

  add(total(definition('stop_behaviour', 'Stop the active behaviour.', {}), async () => {
    const stopped = await deps.reflexes.stopBehaviour();
    if (stopped) ctx.reflexChanged?.();
    return stopped;
  }));

  add(total(definition('remember', 'Store a durable memory.', {
    kind: { type: 'string', enum: [...MEMORY_KINDS] },
    text: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number', minimum: 0, maximum: 1 }
  }, ['kind', 'text']), async (args) => {
    const kind = string(args.kind, 'kind') as MemoryKind;
    if (!MEMORY_KINDS.has(kind)) throw new Error(`kind must be one of ${[...MEMORY_KINDS].join(', ')}`);
    const tags = args.tags === undefined ? undefined : args.tags;
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error('tags must be an array of strings');
    }
    if (args.importance !== undefined && (typeof args.importance !== 'number' || !Number.isFinite(args.importance)
      || args.importance < 0 || args.importance > 1)) throw new Error('importance must be a number from 0 to 1');
    const record = await deps.memory.remember({
      kind,
      text: string(args.text, 'text'),
      ...(tags === undefined ? {} : { tags: tags as string[] }),
      ...(args.importance === undefined ? {} : { importance: args.importance })
    });
    return { id: record.id };
  }));

  add(total(definition('recall', 'Recall relevant long-term memories.', {
    query: { type: 'string' },
    kinds: { type: 'array', items: { type: 'string', enum: [...MEMORY_KINDS] } },
    limit: { type: 'integer', minimum: 1, maximum: 50 }
  }, ['query']), async (args) => {
    if (typeof args.query !== 'string') throw new Error('query must be a string');
    const kinds = args.kinds;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== 'string' || !MEMORY_KINDS.has(kind as MemoryKind)))) {
      throw new Error(`kinds must contain only ${[...MEMORY_KINDS].join(', ')}`);
    }
    const limit = args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50)) {
      throw new Error('limit must be an integer from 1 to 50');
    }
    const hits = await deps.memory.recall({
      text: args.query,
      ...(kinds === undefined ? {} : { kinds: kinds as MemoryKind[] }),
      ...(limit === undefined ? {} : { limit: limit as number })
    });
    return hits.map((hit) => ({ id: hit.record.id, kind: hit.record.kind, text: hit.record.text, score: hit.score }));
  }));

  add(total(definition('forget', 'Delete a memory by numeric id.', {
    id: { type: 'integer', minimum: 1 }
  }, ['id']), async (args) => {
    if (!Number.isInteger(args.id) || (args.id as number) < 1) throw new Error('id must be a positive integer');
    return deps.memory.forget(args.id as number);
  }));

  add(total(definition('send_message', 'Send a mailbox message to an agent, director, or coordinator.', {
    to: { type: 'string' },
    text: { type: 'string' }
  }, ['to', 'text']), (args) => {
    const requested = string(args.to, 'to');
    if (requested !== 'director' && requested !== 'coordinator' && !AGENT_ID.test(requested)) {
      throw new Error("to must be an agent id, 'director', or 'coordinator'");
    }
    const to = requested === 'coordinator'
      ? (deps.spec.team === undefined ? 'director' : `coordinator:${deps.spec.team}` as const)
      : requested;
    if (deps.canMessage?.(deps.agentId, to) === false) {
      throw new Error('cross-team messaging is disabled in this run');
    }
    deps.mailbox.send(to, string(args.text, 'text'));
    return { sent: true, to };
  }));

  add(total(definition('report', 'Report a milestone or blocker to the coordinator, or director when unteamed.', {
    text: { type: 'string' }
  }, ['text']), async (args) => {
    const report = string(args.text, 'text');
    const to = deps.spec.team === undefined ? 'director' : `coordinator:${deps.spec.team}` as const;
    deps.mailbox.send(to, report);
    const record = await deps.memory.remember({ kind: 'episodic', text: report, importance: 0.6 });
    return { sent: true, to, id: record.id };
  }));

  add(total(definition('guide', 'Load an on-demand adapter grounding guide.', {
    name: { type: 'string', enum: guideNames }
  }, ['name']), (args) => {
    const name = string(args.name, 'name');
    if (!guideNames.includes(name as never)) return { error: `Guide '${name}' is not available` };
    return deps.prompts.get(name as PromptName);
  }));

  add(total(definition('sleep', 'End this wake while heartbeat and reflexes continue.', {
    reason: { type: 'string' }
  }), (args) => {
    const reason = optionalString(args.reason, 'reason');
    ctx.endWake();
    return { sleeping: true, ...(reason === undefined ? {} : { reason }) };
  }));

  add(total(definition('finish', 'Permanently finish only when the goal is met or proven impossible.', {
    success: { type: 'boolean' },
    summary: { type: 'string' }
  }, ['success', 'summary']), (args) => {
    const success = boolean(args.success, 'success');
    const summary = string(args.summary, 'summary');
    ctx.finish(success, summary);
    ctx.endWake();
    return { finished: true, success, summary };
  }));

  for (const [name, mcp] of Object.entries(deps.mcpReadTools ?? {})) {
    add(total({
      name: `mcp_${name}`,
      description: mcp.description,
      parameters: mcp.inputSchema
    }, (args) => mcp.call(args)));
  }

  return tools;
}

export function toToolDefinitions(tools: readonly AgentTool[]): ToolDefinition[] {
  return tools.map((tool) => tool.definition);
}
