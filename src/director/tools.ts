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
const AGENT_SPEC_FIELDS = [
  'id', 'displayName', 'tag', 'team', 'goal', 'privateGoal', 'persona', 'voice',
  'reflexPreset', 'spawn', 'useExistingSlot'
] as const;
const SPAWN_FIELDS = ['at', 'stats', 'inventory', 'equipment'] as const;
const TILE_FIELDS = ['x', 'z', 'level'] as const;

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
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
  return value;
}
function rejectUnknown(raw: Readonly<Record<string, unknown>>, path: string, known: readonly string[], hints: Readonly<Record<string, string>> = {}): void {
  const key = Object.keys(raw).find((candidate) => !known.includes(candidate));
  if (key === undefined) return;
  throw new Error(`${path}.${key} is not a recognised field; known fields: ${known.join(', ')}${hints[key] ?? ''}`);
}
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function schema(properties: Record<string, JsonValue>, required: readonly string[] = [], description?: string): JsonValue {
  return {
    type: 'object', properties, ...(required.length === 0 ? {} : { required }),
    additionalProperties: false, ...(description === undefined ? {} : { description })
  };
}

export function validateAgentSpec(value: unknown): AgentSpec {
  const raw = object(value, 'spec');
  rejectUnknown(raw, 'spec', AGENT_SPEC_FIELDS, {
    name: '; use spec.id for the identifier and spec.displayName for a display name',
    actor: '; spawn fields belong in spec.spawn',
    instanceId: '; the agent joins the connected world; omit instanceId'
  });
  const agentId = id(raw.id, 'spec.id');
  const displayName = raw.displayName === undefined ? undefined : string(raw.displayName, 'spec.displayName');
  const tag = raw.tag === undefined ? undefined : id(raw.tag, 'spec.tag');
  const team = raw.team === undefined ? undefined : id(raw.team, 'spec.team');
  let goal: string | undefined;
  if (raw.goal !== undefined) {
    if (typeof raw.goal !== 'string') throw new Error('spec.goal must be a string');
    goal = raw.goal;
  }
  const privateGoal = raw.privateGoal === undefined ? undefined : boolean(raw.privateGoal, 'spec.privateGoal');
  const persona = raw.persona === undefined ? undefined : string(raw.persona, 'spec.persona');
  const voice = raw.voice === undefined ? undefined : string(raw.voice, 'spec.voice');
  const reflexPreset = raw.reflexPreset === undefined ? undefined : string(raw.reflexPreset, 'spec.reflexPreset');
  const useExistingSlot = raw.useExistingSlot === undefined ? undefined : boolean(raw.useExistingSlot, 'spec.useExistingSlot');

  let spawn: AgentSpec['spawn'];
  if (raw.spawn !== undefined) {
    let rawSpawn = object(raw.spawn, 'spec.spawn');
    if (rawSpawn.at === undefined
      && typeof rawSpawn.x === 'number' && Number.isFinite(rawSpawn.x)
      && typeof rawSpawn.z === 'number' && Number.isFinite(rawSpawn.z)
      && typeof rawSpawn.level === 'number' && Number.isFinite(rawSpawn.level)) {
      const { x, z, level, ...remaining } = rawSpawn;
      rawSpawn = { ...remaining, at: { x, z, level } };
    }
    rejectUnknown(rawSpawn, 'spec.spawn', SPAWN_FIELDS);

    let at: NonNullable<AgentSpec['spawn']>['at'];
    if (rawSpawn.at !== undefined) {
      const rawAt = object(rawSpawn.at, 'spec.spawn.at');
      rejectUnknown(rawAt, 'spec.spawn.at', TILE_FIELDS);
      at = {
        x: number(rawAt.x, 'spec.spawn.at.x'),
        z: number(rawAt.z, 'spec.spawn.at.z'),
        level: number(rawAt.level, 'spec.spawn.at.level')
      };
    }

    let stats: Readonly<Record<string, number>> | undefined;
    if (rawSpawn.stats !== undefined) {
      const rawStats = object(rawSpawn.stats, 'spec.spawn.stats');
      stats = Object.fromEntries(Object.entries(rawStats).map(([key, value]) => [
        key, number(value, `spec.spawn.stats.${key}`)
      ]));
    }

    let inventory: NonNullable<AgentSpec['spawn']>['inventory'];
    if (rawSpawn.inventory !== undefined) {
      if (!Array.isArray(rawSpawn.inventory)) throw new Error('spec.spawn.inventory must be an array');
      inventory = rawSpawn.inventory.map((value, index) => {
        const entry = object(value, `spec.spawn.inventory[${index}]`);
        rejectUnknown(entry, `spec.spawn.inventory[${index}]`, ['item', 'amount']);
        const amount = entry.amount === undefined ? undefined : number(entry.amount, `spec.spawn.inventory[${index}].amount`);
        return {
          item: number(entry.item, `spec.spawn.inventory[${index}].item`),
          ...(amount === undefined ? {} : { amount })
        };
      });
    }

    let equipment: NonNullable<AgentSpec['spawn']>['equipment'];
    if (rawSpawn.equipment !== undefined) {
      if (!Array.isArray(rawSpawn.equipment)) throw new Error('spec.spawn.equipment must be an array');
      equipment = rawSpawn.equipment.map((value, index) => {
        const entry = object(value, `spec.spawn.equipment[${index}]`);
        rejectUnknown(entry, `spec.spawn.equipment[${index}]`, ['item']);
        return { item: number(entry.item, `spec.spawn.equipment[${index}].item`) };
      });
    }

    spawn = {
      ...(at === undefined ? {} : { at }),
      ...(stats === undefined ? {} : { stats }),
      ...(inventory === undefined ? {} : { inventory }),
      ...(equipment === undefined ? {} : { equipment })
    };
  }

  return {
    id: agentId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(tag === undefined ? {} : { tag }),
    ...(team === undefined ? {} : { team }),
    ...(goal === undefined ? {} : { goal }),
    ...(privateGoal === undefined ? {} : { privateGoal }),
    ...(persona === undefined ? {} : { persona }),
    ...(voice === undefined ? {} : { voice }),
    ...(reflexPreset === undefined ? {} : { reflexPreset }),
    ...(spawn === undefined ? {} : { spawn }),
    ...(useExistingSlot === undefined ? {} : { useExistingSlot })
  };
}

const SPAWN_AGENT_PARAMETERS = schema({
  spec: schema({
    id: { type: 'string', pattern: ID.source, description: 'Stable agent identifier.' },
    displayName: { type: 'string', description: 'Display name shown for the actor.' },
    tag: { type: 'string', pattern: ID.source, description: 'Actor slot tag; defaults to id. Ignored in the shared hosted world, where the server assigns the tag.' },
    team: { type: 'string', pattern: ID.source, description: 'Team identifier for this agent.' },
    goal: { type: 'string', description: 'Initial outcome assigned to the agent.' },
    privateGoal: { type: 'boolean', description: 'Hide the goal from director and coordinator reports.' },
    persona: { type: 'string', description: 'Standing identity and behaviour instructions.' },
    voice: { type: 'string', description: 'Tone, diction, and catchphrases for speech.' },
    reflexPreset: { type: 'string', description: 'Built-in reflex preset to install.' },
    useExistingSlot: { type: 'boolean', description: 'Claim an existing actor slot instead of creating one.' },
    spawn: schema({
      at: schema({
        x: { type: 'number', description: 'Tile x coordinate.' },
        z: { type: 'number', description: 'Tile z coordinate.' },
        level: { type: 'number', description: 'Tile level.' }
      }, ['x', 'z', 'level'], 'Tile the actor is created on; required when the connected world has no default spawn, such as an attached existing instance. Ignored in the shared hosted world, where the server assigns the spawn tile.'),
      stats: {
        type: 'object', description: 'Initial stat values keyed by stat name.',
        additionalProperties: { type: 'number' }
      },
      inventory: {
        type: 'array', description: 'Items placed in the initial inventory.',
        items: schema({
          item: { type: 'number', description: 'Item definition id.' },
          amount: { type: 'number', description: 'Stack amount; defaults to one.' }
        }, ['item'])
      },
      equipment: {
        type: 'array', description: 'Items equipped when the actor is created.',
        items: schema({ item: { type: 'number', description: 'Item definition id.' } }, ['item'])
      }
    }, [], 'Initial actor placement and loadout.')
  }, ['id'], 'Validated specification for the new harness agent.')
}, ['spec']);

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
    const knownAgents = runtime.view.agents();
    if (!knownAgents.some((entry) => entry.id === agentId)) {
      const known = knownAgents.map((entry) => entry.id).join(', ') || '(none)';
      const adminHint = agentId === 'admin' ? '; the admin persona is reached with ask_admin' : '';
      throw new Error(`Unknown agent '${agentId}'; known agents: ${known}${adminHint}`);
    }
    return agentId;
  };
  return [
    tool('list_agents', 'List current harness agents.', schema({}), async () => json(runtime.view.agents())),
    tool('spawn_agent', 'Spawn an agent into the currently connected world; no instance id is needed. spawn.at is a { x, z, level } tile, and tag defaults to id. In the shared hosted world, the server assigns the tag and spawn tile, so both fields are ignored.', SPAWN_AGENT_PARAMETERS, async (args) => {
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
