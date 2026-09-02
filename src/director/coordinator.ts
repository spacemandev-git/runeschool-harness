import type { JsonValue } from '#protocol';
import type { AgentHandle, ChatMessage, HarnessBus, ModelRegistry, PromptLibrary, TeamId, ToolDefinition } from '../core/index.ts';
import { charEstimator } from '../models/index.ts';
import { createContextManager } from '../mind/contextManager.ts';
import type { Mailboxes } from '../runtime/mailbox.ts';

export interface CoordinatorTeam {
  readonly id: TeamId;
  readonly mission: string;
  readonly agents: readonly string[];
}
export interface Coordinator {
  say(text: string): Promise<void>;
  notify(): void;
  transcript(): readonly ChatMessage[];
  dispose(): void;
}
export interface CoordinatorDeps {
  readonly agents: () => readonly AgentHandle[];
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly bus: HarnessBus;
  readonly mailboxes: Mailboxes;
}
interface Tool { definition: ToolDefinition; run(args: Record<string, unknown>): Promise<JsonValue>; }

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function parse(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tool arguments must be an object');
  return value as Record<string, unknown>;
}
const parameters = (properties: Record<string, JsonValue>, required: string[]): JsonValue =>
  ({ type: 'object', properties, required, additionalProperties: false });

export function createCoordinator(team: CoordinatorTeam, deps: CoordinatorDeps): Coordinator {
  const own = (value: unknown): AgentHandle => {
    const id = string(value, 'agent');
    if (!team.agents.includes(id)) throw new Error(`Agent '${id}' is not on team '${team.id}'`);
    const found = deps.agents().find((agent) => agent.id === id);
    if (found === undefined) throw new Error(`Unknown agent '${id}'`);
    return found;
  };
  const tools: Tool[] = [
    {
      definition: { name: 'assign_goal', description: 'Assign a goal to one of your agents.', parameters: parameters({ agent: { type: 'string' }, goal: { type: 'string' } }, ['agent', 'goal']) },
      async run(args) { await own(args.agent).setGoal(string(args.goal, 'goal'), 'coordinator'); return { ok: true }; }
    },
    {
      definition: { name: 'message_agent', description: 'Send guidance to one of your agents.', parameters: parameters({ agent: { type: 'string' }, text: { type: 'string' } }, ['agent', 'text']) },
      async run(args) { deps.mailboxes.send(`coordinator:${team.id}`, own(args.agent).id, string(args.text, 'text')); return { ok: true }; }
    },
    {
      definition: { name: 'team_status', description: 'Read all team agent summaries.', parameters: parameters({}, []) },
      async run() { return team.agents.map((id) => deps.agents().find((agent) => agent.id === id)?.summary() ?? `${id}: missing`); }
    },
    {
      definition: { name: 'report_to_director', description: 'Report a milestone or blocker to the director.', parameters: parameters({ text: { type: 'string' } }, ['text']) },
      async run(args) {
        const text = string(args.text, 'text');
        deps.bus.emit('team.report', { teamId: team.id, text });
        deps.mailboxes.send(`coordinator:${team.id}`, 'director', text);
        return { ok: true };
      }
    }
  ];
  const definitions = tools.map((tool) => tool.definition);
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  let directorNotes: string[] = [];
  const context = createContextManager({
    role: 'coordinator', models: deps.models, estimator: charEstimator,
    budget: { maxPromptTokens: 18_000, compactAtTokens: 13_000, keepTurns: 6, recallLimit: 0 }, bus: deps.bus, tools: definitions,
    systemPrompt: () => deps.prompts.render('coordinator-system', {
      team: team.id,
      mission: team.mission,
      agents: team.agents.map((id) => deps.agents().find((agent) => agent.id === id)?.summary() ?? `${id}: missing`).join('\n'),
      director_notes: directorNotes.join('\n') || 'none'
    })
  });
  const queue: { text: string; resolve: () => void; reject: (error: unknown) => void }[] = [];
  let busy = false;
  let disposed = false;
  let autoQueued = false;

  function collect(): string[] {
    const lines = deps.mailboxes.drain(`coordinator:${team.id}`).map((message) => `[from ${message.from}] ${message.text}`);
    directorNotes.push(...lines);
    directorNotes = directorNotes.slice(-20);
    return lines;
  }
  async function turn(text: string): Promise<void> {
    const inbound = collect();
    context.push({ role: 'user', content: [...inbound, text].filter(Boolean).join('\n') });
    let calls = 0;
    while (calls < 30 && !disposed) {
      const response = await deps.models.chat('coordinator', { messages: context.messages(), tools: definitions, toolChoice: 'auto' });
      context.push(response.message);
      deps.bus.emit('coordinator.turn', { teamId: team.id, message: response.message, ...(response.usage === undefined ? {} : { usage: response.usage }) });
      const requested = response.message.toolCalls ?? [];
      if (requested.length === 0) break;
      for (const call of requested) {
        if (calls++ >= 30) break;
        let result: JsonValue;
        try {
          const selected = byName.get(call.name);
          if (selected === undefined) throw new Error(`Unknown tool '${call.name}'`);
          result = await selected.run(parse(call.arguments));
        } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        context.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      }
    }
    await context.maybeCompact();
  }
  async function pump(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    while (queue.length > 0 && !disposed) {
      const job = queue.shift()!; autoQueued = false;
      try { await turn(job.text); job.resolve(); } catch (error) { job.reject(error); }
    }
    busy = false;
  }
  function enqueue(text: string): Promise<void> {
    return new Promise((resolve, reject) => { queue.push({ text, resolve, reject }); void pump(); });
  }
  const unsubs = [
    deps.bus.on('agent.finished', (event) => { if (team.agents.includes(event.data.agentId)) api.notify(); }),
    deps.bus.on('agent.state', (event) => {
      if (team.agents.includes(event.data.agentId) && ['dead', 'errored'].includes(event.data.state)) api.notify();
    })
  ];
  const api: Coordinator = {
    say: enqueue,
    notify(): void {
      collect();
      if (autoQueued || disposed) return;
      autoQueued = true;
      void enqueue('Update: review team status and act if needed.').catch(() => {});
    },
    transcript: () => context.transcript(),
    dispose(): void { disposed = true; for (const unsubscribe of unsubs) unsubscribe(); }
  };
  if (team.mission.trim().length > 0) void enqueue(`Initial mission: ${team.mission}. Assign goals now.`).catch((error) => {
    deps.bus.emit('log', { level: 'error', scope: `coordinator:${team.id}`, message: error instanceof Error ? error.message : String(error) });
  });
  return api;
}
