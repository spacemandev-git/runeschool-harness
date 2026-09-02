import type { JsonValue } from '#protocol';
import type {
  AgentSpec, HarnessBus, McpSession, ModelRegistry, ModelRole, RuntimeCommands, RuntimeView, TeamId,
  ToolDefinition
} from '../core/index.ts';
import type { Mailboxes } from '../runtime/mailbox.ts';

export interface RuntimeInternals {
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  createTeam(id: TeamId, mission: string, agents: readonly string[]): Promise<void>;
  watchUrl(): string | undefined;
}

export interface DirectorTool {
  readonly definition: ToolDefinition;
  run(args: Readonly<Record<string, unknown>>): Promise<JsonValue>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}
function id(value: unknown, path: string): string {
  const result = string(value, path);
  if (!ID.test(result)) throw new Error(`${path} must match ${ID.source}`);
  return result;
}
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function schema(properties: Record<string, JsonValue>, required: readonly string[] = []): JsonValue {
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

export function validateAgentSpec(value: unknown): AgentSpec {
  const raw = object(value, 'spec');
  const agentId = id(raw.id, 'spec.id');
  const tag = raw.tag === undefined ? undefined : id(raw.tag, 'spec.tag');
  const team = raw.team === undefined ? undefined : id(raw.team, 'spec.team');
  if (raw.goal !== undefined && typeof raw.goal !== 'string') throw new Error('spec.goal must be a string');
  if (raw.privateGoal !== undefined && typeof raw.privateGoal !== 'boolean') throw new Error('spec.privateGoal must be a boolean');
  return { ...raw, id: agentId, ...(tag === undefined ? {} : { tag }), ...(team === undefined ? {} : { team }) } as unknown as AgentSpec;
}

export function createMcpPassthroughTools(mcp: McpSession): readonly DirectorTool[] {
  return mcp.tools().map((tool) => ({
    definition: { name: tool.name, description: `MCP: ${tool.description ?? tool.name}`, parameters: tool.inputSchema },
    async run(args): Promise<JsonValue> {
      const result = await mcp.call(tool.name, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      if (text.length <= 6_000) return result;
      return `${text.slice(0, 5_980)}\n[truncated]`;
    }
  }));
}

export function createHarnessTools(runtime: RuntimeInternals, bus: HarnessBus, mailboxes: Mailboxes, models?: ModelRegistry): readonly DirectorTool[] {
  const tool = (name: string, description: string, parameters: JsonValue,
    run: DirectorTool['run']): DirectorTool => ({ definition: { name, description, parameters }, run });
  const agent = (value: unknown) => {
    const agentId = id(value, 'agent');
    if (!runtime.view.agents().some((entry) => entry.id === agentId)) throw new Error(`Unknown agent '${agentId}'`);
    return agentId;
  };
  return [
    tool('list_agents', 'List current harness agents.', schema({}), async () => json(runtime.view.agents())),
    tool('spawn_agent', 'Spawn a new harness agent.', schema({ spec: { type: 'object' } }, ['spec']), async (args) => {
      const spec = validateAgentSpec(args.spec);
      await runtime.commands.spawnAgent(spec);
      return { ok: true, agent: spec.id };
    }),
    ...(runtime.commands.removeAgent === undefined ? [] : [
      tool('remove_agent', 'Stop and remove an agent runtime without deleting its world actor.', schema({
        agent: { type: 'string' }, reason: { type: 'string' }
      }, ['agent']), async (args) => {
        const agentId = id(args.agent, 'agent');
        const reason = args.reason === undefined ? undefined : string(args.reason, 'reason');
        return await runtime.commands.removeAgent!(agentId, reason);
      })
    ]),
    tool('assign_goal', 'Assign or replace an agent goal.', schema({ agent: { type: 'string' }, goal: { type: 'string' } }, ['agent', 'goal']), async (args) => {
      const agentId = agent(args.agent); const goal = string(args.goal, 'goal');
      await runtime.commands.setAgentGoal(agentId, goal); return { ok: true };
    }),
    tool('message_agent', 'Send guidance to an agent.', schema({ agent: { type: 'string' }, text: { type: 'string' } }, ['agent', 'text']), async (args) => {
      const agentId = agent(args.agent); await runtime.commands.agentSay(agentId, string(args.text, 'text')); return { ok: true };
    }),
    tool('agent_report', 'Read status, recent transcript, and reflex state.', schema({ agent: { type: 'string' } }, ['agent']), async (args) => {
      const agentId = agent(args.agent);
      const summary = runtime.view.agents().find((entry) => entry.id === agentId);
      if (summary?.privateGoal === true) return json({ summary });
      return json({
        summary,
        transcript: runtime.view.agentTranscript(agentId).slice(-20),
        reflexes: runtime.view.agentReflexes(agentId)
      });
    }),
    tool('pause_agent', 'Pause an agent mind; reflex pulses continue.', schema({ agent: { type: 'string' }, blind: { type: 'boolean' } }, ['agent']), async (args) => {
      const blind = args.blind === undefined ? false : boolean(args.blind, 'blind');
      runtime.commands.pauseAgent(agent(args.agent), undefined, { blind }); return { ok: true };
    }),
    tool('resume_agent', 'Resume a paused agent mind.', schema({ agent: { type: 'string' } }, ['agent']), async (args) => {
      runtime.commands.resumeAgent(agent(args.agent)); return { ok: true };
    }),
    tool('create_team', 'Create a team and coordinator.', schema({ id: { type: 'string' }, mission: { type: 'string' }, agents: { type: 'array', items: { type: 'string' } } }, ['id', 'mission', 'agents']), async (args) => {
      const teamId = id(args.id, 'id'); const mission = string(args.mission, 'mission');
      if (!Array.isArray(args.agents)) throw new Error('agents must be an array');
      const agents = args.agents.map((value) => agent(value));
      await runtime.createTeam(teamId, mission, agents); return { ok: true, team: teamId };
    }),
    tool('set_agent_model', 'Set a per-agent model override.', schema({ agent: { type: 'string' }, role: { type: 'string' }, model: { type: 'string' } }, ['agent', 'model']), async (args) => {
      const agentId = agent(args.agent); const role = (args.role ?? 'agent') as ModelRole;
      if (!['director', 'coordinator', 'agent', 'summarizer', 'admin'].includes(role)) throw new Error('role is invalid');
      const model = string(args.model, 'model');
      if (models === undefined) throw new Error('Runtime does not support model overrides');
      models.setOverride(agentId, role, { model }); return { ok: true };
    }),
    tool('stop_run', 'Gracefully stop the harness run.', schema({ reason: { type: 'string' } }, ['reason']), async (args) => {
      await runtime.commands.stop(string(args.reason, 'reason')); return { ok: true };
    }),
    tool('watch_url', 'Return the spectator URL.', schema({}), async () => ({ watchUrl: runtime.watchUrl() ?? null })),
    tool('ask_admin', 'Ask the admin persona to change the world.', schema({ text: { type: 'string' } }, ['text']), async (args) => {
      mailboxes.send('director', 'admin', string(args.text, 'text'));
      return { ok: true, note: 'the admin replies to your mailbox' };
    })
  ];
}

export function toolDefinitions(tools: readonly DirectorTool[]): readonly ToolDefinition[] {
  return tools.map((entry) => entry.definition);
}
