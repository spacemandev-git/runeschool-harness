import { ACTOR_COMMAND_TYPES } from '#protocol';
import type { JsonValue } from '#protocol';
import { AGENT_DENIED_COMMANDS } from '../core/actions.ts';
import type {
  Admin, AgentSpec, LiveRuntimeCommands, ModelRegistry, ModelRole, ModelSpec, RunConfig, RuntimeView, TeamId
} from '../core/index.ts';
import type { Coordinator, Director } from '../director/index.ts';
import { validateAndApplyModelSelection } from '../models/selection.ts';
import type { AgentRuntime } from './agentRuntime.ts';
import { redactSecrets } from './trace.ts';

export interface RuntimeTeamRecord {
  readonly id: TeamId;
  readonly mission: string;
  readonly agents: string[];
  coordinator?: Coordinator;
  lastReport?: string;
}

export interface RuntimeSurfaceState {
  readonly config: RunConfig;
  readonly startedAt: number;
  readonly models: ModelRegistry;
  readonly agents: () => readonly AgentRuntime[];
  readonly teams: () => readonly RuntimeTeamRecord[];
  readonly director: () => Director | undefined;
  readonly admin: () => Admin | undefined;
  readonly world: () => { readonly instanceId: string; readonly httpUrl: string; readonly kind: string } | undefined;
  readonly watchUrl: () => string | undefined;
  readonly spawnAgent: (spec: AgentSpec) => Promise<void>;
  readonly removeAgent: (agentId: string, reason?: string) => Promise<{ readonly removed: boolean }>;
  readonly createTeam: (id: TeamId, mission: string, agents: readonly string[]) => Promise<void>;
  readonly stop: (reason: string) => Promise<void>;
  readonly directorSay: (text: string) => Promise<void>;
  readonly adminSay: (text: string) => Promise<void>;
  readonly coordinatorSay: (team: TeamId, text: string) => Promise<void>;
  readonly agentSay: (agent: string, text: string) => Promise<void>;
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function redactTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTokenFields);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /token/i.test(key) ? '[REDACTED]' : redactTokenFields(entry)
  ]));
}
function supervisorSafeConfig(config: RunConfig): Record<string, unknown> {
  return {
    ...config,
    agents: config.agents.map((spec) => {
      const { persona: _persona, ...visible } = spec;
      return spec.privateGoal === true ? { ...visible, goal: '(private)' } : visible;
    })
  };
}

export function createRuntimeSurface(state: RuntimeSurfaceState): {
  readonly view: RuntimeView;
  readonly commands: LiveRuntimeCommands;
} {
  const find = (id: string): AgentRuntime => {
    const agent = state.agents().find((entry) => entry.id === id);
    if (agent === undefined) throw new Error(`Unknown agent '${id}'`);
    return agent;
  };
  const resolvedModel = (role: ModelRole, agentId?: string): string => {
    try { return state.models.resolve(role, agentId).model; } catch { return 'unresolved'; }
  };
  const view: RuntimeView = {
    runId: state.config.runId,
    startedAt: state.startedAt,
    get instance() {
      const world = state.world();
      if (world === undefined) return undefined;
      const tick = Math.max(0, ...state.agents().map((agent) => {
        try { return agent.view.snapshot().tick; } catch { return 0; }
      }));
      return { id: world.instanceId, httpUrl: world.httpUrl, kind: world.kind, tick, ...(state.watchUrl() === undefined ? {} : { watchUrl: state.watchUrl() }) };
    },
    agents() {
      return state.agents().map((agent) => {
        let snapshot;
        try { snapshot = agent.view.snapshot(); } catch { snapshot = undefined; }
        const status = agent.mind.status();
        let model = 'unresolved';
        try { model = state.models.resolve('agent', agent.id).model; } catch { /* displayed as unresolved */ }
        return {
          id: agent.id,
          displayName: agent.spec.displayName ?? agent.id,
          tag: agent.tag,
          entity: agent.entity,
          ...(agent.team === undefined ? {} : { team: agent.team }),
          state: agent.state,
          ...(agent.goal === undefined && agent.spec.privateGoal !== true ? {} : {
            goal: agent.spec.privateGoal === true ? '(private)' : agent.goal
          }),
          ...(agent.spec.privateGoal === undefined ? {} : { privateGoal: agent.spec.privateGoal }),
          model,
          ...(snapshot === undefined ? {} : {
            hp: snapshot.self.hp,
            at: snapshot.self.at,
            activity: snapshot.self.activity.kind as string
          }),
          activity: snapshot?.self.activity.kind ?? agent.state,
          ...(agent.reflexes.state().behaviour === undefined ? {} : { behaviour: agent.reflexes.state().behaviour!.description }),
          ...(status.lastWakeAt === undefined ? {} : { lastWakeAt: status.lastWakeAt }),
          turns: status.turns
        };
      });
    },
    teams() {
      return state.teams().map((team) => {
        let coordinatorModel = 'unresolved';
        try { coordinatorModel = state.models.resolve('coordinator').model; } catch { /* display fallback */ }
        return {
          id: team.id, mission: team.mission, agents: team.agents, coordinatorModel,
          ...(team.lastReport === undefined ? {} : { lastReport: team.lastReport })
        };
      });
    },
    agentSnapshot(id) { return state.agents().find((agent) => agent.id === id)?.view.snapshot(); },
    agentReflexes(id) { return state.agents().find((agent) => agent.id === id)?.reflexes.state(); },
    agentTranscript(id) { return state.agents().find((agent) => agent.id === id)?.mind.transcript() ?? []; },
    directorTranscript() { return state.director()?.transcript() ?? []; },
    adminTranscript() { return state.admin()?.transcript() ?? []; },
    coordinatorTranscript(team) { return state.teams().find((entry) => entry.id === team)?.coordinator?.transcript() ?? []; },
    usage: () => state.models.usage(),
    config: () => json(redactSecrets(redactTokenFields({
      ...supervisorSafeConfig(state.config),
      models: {
        director: resolvedModel('director'),
        admin: resolvedModel('admin'),
        agentDefault: resolvedModel('agent'),
        coordinators: Object.fromEntries(state.teams().map((team) => [
          team.id, resolvedModel('coordinator', team.id)
        ])),
        agents: Object.fromEntries(state.agents().map((agent) => [
          agent.id, resolvedModel('agent', agent.id)
        ]))
      }
    })))
  };
  const commands: LiveRuntimeCommands & {
    setAgentModel(agentId: string, role: ModelRole, spec: Partial<ModelSpec>): void;
    createTeam(id: TeamId, mission: string, agents: readonly string[]): Promise<void>;
  } = {
    directorSay: state.directorSay,
    adminSay: state.adminSay,
    agentSay: state.agentSay,
    coordinatorSay: state.coordinatorSay,
    async setAgentGoal(agentId, goal): Promise<void> { await find(agentId).setGoal(goal, 'operator'); },
    pauseAgent(agentId, reason = 'operator', opts): void { find(agentId).pause(reason, opts); },
    resumeAgent(agentId): void { find(agentId).resume(); },
    async agentCommand(agentId, type, data): Promise<JsonValue> {
      if (!ACTOR_COMMAND_TYPES.includes(type as never) || AGENT_DENIED_COMMANDS.includes(type)) {
        throw new Error(`Command '${type}' is not allowed for actors`);
      }
      const agent = find(agentId);
      return json(await agent.link.sendRaw(type, { ...data, entity: agent.entity }));
    },
    spawnAgent: state.spawnAgent,
    removeAgent: state.removeAgent,
    stop: state.stop,
    async setModel(selection): Promise<void> {
      if (selection.role === 'agent') find(selection.agent);
      await validateAndApplyModelSelection(state.models, selection);
    },
    setAgentModel(agentId, role, spec): void { find(agentId); state.models.setOverride(agentId, role, spec); },
    createTeam: state.createTeam
  };
  return { view, commands };
}
