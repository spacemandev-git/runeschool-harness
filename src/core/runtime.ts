/**
 * Runtime contracts consumed by the TUI and the headless CLI. The TUI depends ONLY on
 * {@link HarnessBus}, {@link RuntimeView}, and {@link RuntimeCommands}; it never touches agents directly.
 */
import type { JsonValue } from '#protocol';
import type { AgentSpec } from './agent.ts';
import type { ChatMessage, UsageByKey } from './model.ts';
import type { WorldSnapshot } from './percept.ts';
import type { ReflexEngineState } from './reflex.ts';
import type { AgentId, AgentState, ChannelPolicy, ModelRole, PauseOptions, RunId, TeamId } from './types.ts';
import type { ModelSpec } from './model.ts';
import type { WorldSelection } from './transport.ts';

export interface AgentSummary {
  readonly id: AgentId;
  readonly displayName: string;
  readonly tag: string;
  readonly entity: number;
  readonly team?: TeamId;
  readonly state: AgentState;
  readonly goal?: string;
  readonly privateGoal?: boolean;
  readonly model: string;
  readonly hp?: { readonly current: number; readonly max: number };
  readonly at?: { readonly x: number; readonly z: number; readonly level: number };
  readonly activity: string;
  readonly behaviour?: string;
  readonly lastWakeAt?: number;
  readonly turns: number;
}

export interface TeamSummary {
  readonly id: TeamId;
  readonly mission: string;
  readonly agents: readonly AgentId[];
  readonly coordinatorModel: string;
  readonly lastReport?: string;
}

export interface RuntimeView {
  readonly runId: RunId;
  readonly startedAt: number;
  readonly instance?: { readonly id: string; readonly httpUrl: string; readonly watchUrl?: string; readonly kind: string; readonly tick: number };
  agents(): readonly AgentSummary[];
  teams(): readonly TeamSummary[];
  agentSnapshot(id: AgentId): WorldSnapshot | undefined;
  agentReflexes(id: AgentId): ReflexEngineState | undefined;
  agentTranscript(id: AgentId): readonly ChatMessage[];
  directorTranscript(): readonly ChatMessage[];
  adminTranscript(): readonly ChatMessage[];
  coordinatorTranscript(team: TeamId): readonly ChatMessage[];
  usage(): readonly UsageByKey[];
  /** Redacted, JSON-safe config for display. */
  config(): JsonValue;
}

export interface RuntimeCommands {
  /** Send a chat message to the director (returns when its turn completes). */
  directorSay(text: string): Promise<void>;
  /** Send a chat message to the admin (game master); resolves when its turn completes. */
  adminSay(text: string): Promise<void>;
  agentSay(agentId: AgentId, text: string): Promise<void>;
  coordinatorSay(team: TeamId, text: string): Promise<void>;
  setAgentGoal(agentId: AgentId, goal: string): Promise<void>;
  pauseAgent(agentId: AgentId, reason?: string, opts?: PauseOptions): void;
  resumeAgent(agentId: AgentId): void;
  /** Operator console: raw command as an agent (entity injected). */
  agentCommand(agentId: AgentId, type: string, data: Readonly<Record<string, unknown>>): Promise<JsonValue>;
  spawnAgent(spec: AgentSpec): Promise<void>;
  /** Dynamically remove one mind/runtime while leaving its world actor untouched. */
  removeAgent?(agentId: AgentId, reason?: string): Promise<{ readonly removed: boolean }>;
  setAgentModel?(agentId: AgentId, role: ModelRole, spec: Partial<ModelSpec>): void;
  createTeam?(id: TeamId, mission: string, agents: readonly AgentId[]): Promise<void>;
  /** Graceful shutdown; resolves when sockets/MCP are closed and the trace is flushed. */
  stop(reason: string): Promise<void>;
}

/** Complete command surface provided by live and remotely connected harness runtimes. */
export interface LiveRuntimeCommands extends RuntimeCommands {
  removeAgent(agentId: AgentId, reason?: string): Promise<{ readonly removed: boolean }>;
  setAgentModel(agentId: AgentId, role: ModelRole, spec: Partial<ModelSpec>): void;
  createTeam(id: TeamId, mission: string, agents: readonly AgentId[]): Promise<void>;
}

/** Everything the CLI needs to start a run. Built by `cli/config.ts`. */
export interface RunConfig {
  readonly runId: RunId;
  readonly mcpUrl: string;
  readonly uiUrl: string;
  readonly world: WorldSelection;
  readonly agents: readonly AgentSpec[];
  readonly teams?: readonly { readonly id: TeamId; readonly mission: string; readonly agents: readonly AgentId[] }[];
  /** Agent-to-agent mailbox policy. Defaults to `open`. */
  readonly channels?: ChannelPolicy;
  /** Include serialized prompts in `model.request` events. Defaults to false. */
  readonly traceModelMessages?: boolean;
  /** Initial instruction for the director, if any (headless runs usually set this or per-agent goals). */
  readonly directorPrompt?: string;
  /** Initial instruction for the admin (game master), if any. */
  readonly adminPrompt?: string;
  readonly headless: boolean;
  readonly logDir: string;
  readonly dataDir: string;
  /** Path of the model config JSON (or undefined for env-derived defaults). */
  readonly modelConfigPath?: string;
  /** Stop when every agent is finished/dead (headless) after this many ms of inactivity. */
  readonly idleExitMs?: number;
  readonly maxRunMs?: number;
  /** Expose the run over a per-run control socket so a cockpit can attach/detach (see control.ts). Default true. */
  readonly serve?: boolean;
  /** Never exit on agent inactivity (daemon default); `maxRunMs` and `run.error` still end the run. */
  readonly keepAlive?: boolean;
  /** Where a daemonised run writes stdout/stderr; recorded in the control descriptor. */
  readonly daemonLogPath?: string;
}
