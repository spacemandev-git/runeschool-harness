/**
 * Agent contracts: configuration, the runtime handle other layers see, and the Mind interface.
 */
import type { JsonValue, TileCoord } from '#protocol';
import type { ActionSink } from './actions.ts';
import type { HarnessBus } from './bus.ts';
import type { MemoryStore } from './memory.ts';
import type { ModelRegistry, ModelSpec } from './model.ts';
import type { WorldView } from './percept.ts';
import type { PromptLibrary } from './prompts.ts';
import type { ReflexEngine, Rule } from './reflex.ts';
import type { AgentId, AgentState, ModelRole, PauseOptions, TeamId, WakeReason } from './types.ts';

export interface AgentSpec {
  readonly id: AgentId;
  readonly displayName?: string;
  /** Actor tag in the instance; defaults to `id`. Must be unique per instance. */
  readonly tag?: string;
  readonly team?: TeamId;
  readonly goal?: string;
  /** Hide the goal from director/coordinator summaries and agent transcript reports. */
  readonly privateGoal?: boolean;
  /** Persona / standing instructions appended to the system prompt. */
  readonly persona?: string;
  /** How the character speaks: tone, diction, and catchphrases; distinct from persona (who they are). */
  readonly voice?: string;
  readonly models?: Partial<Record<ModelRole, Partial<ModelSpec>>>;
  /** Rules installed before the first wake. */
  readonly rules?: readonly Rule[];
  /** Optional adapter-defined reflex preset name. */
  readonly reflexPreset?: string;
  readonly spawn?: {
    readonly at?: TileCoord;
    readonly stats?: Readonly<Record<string, number>>;
    readonly inventory?: readonly { readonly item: number; readonly amount?: number }[];
    readonly equipment?: readonly { readonly item: number }[];
  };
  /** Use an actor slot that already exists in the provisioned world instead of add_player. */
  readonly useExistingSlot?: boolean;
  readonly wake?: Partial<WakePolicyConfig>;
  readonly context?: Partial<ContextBudget>;
}

export interface WakePolicyConfig {
  /** Minimum ms between two mind turns. */
  readonly minIntervalMs: number;
  /** Wake if nothing else happened for this long while a goal is set. */
  readonly heartbeatMs: number;
  /** HP fraction at/below which a drop wakes the mind (reflexes handle eating; the mind re-plans). */
  readonly hpAlertFraction: number;
  /** Max mind turns per run; 0 = unlimited. */
  readonly maxTurns: number;
  /** Max consecutive tool calls in one wake before forcing a yield. */
  readonly maxToolCallsPerWake: number;
}

export interface ContextBudget {
  /** Target upper bound for the prompt in estimated tokens. */
  readonly maxPromptTokens: number;
  /** Compact when above this; keep the last `keepTurns` turns verbatim. */
  readonly compactAtTokens: number;
  readonly keepTurns: number;
  /** Max memory hits auto-injected per wake. */
  readonly recallLimit: number;
}

export interface Mailbox {
  send(to: AgentId | 'director' | 'admin' | `coordinator:${string}`, text: string): void;
  /** Drain pending inbound messages (oldest first). */
  drain(): readonly { readonly from: string; readonly text: string; readonly at: number }[];
  pending(): number;
}

/** Everything a Mind implementation is given. Constructed by the runtime. */
export interface MindDeps {
  readonly agentId: AgentId;
  readonly spec: AgentSpec;
  readonly view: WorldView;
  readonly sink: ActionSink;
  /** Commands exposed to this mind by the active world adapter. */
  readonly commandTypes: readonly string[];
  /** Adapter-specific commands that must never be available to autonomous agents. */
  readonly deniedCommandTypes?: readonly string[];
  /** Duration of one adapter pulse. Defaults to 600 ms. */
  readonly pulseMs?: number;
  readonly reflexes: ReflexEngine;
  readonly memory: MemoryStore;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly bus: HarnessBus;
  readonly mailbox: Mailbox;
  /** Runtime-owned channel policy. Supervisory recipients are always allowed. */
  readonly canMessage?: (from: AgentId, to: AgentId | 'director' | 'admin' | `coordinator:${string}`) => boolean;
  /** World context supplied during provisioning. */
  readonly worldContext: JsonValue;
  /**
   * Optional instance-wide reads beyond the agent's local view, supplied by the runtime.
   */
  readonly worldReads: {
    scan(query: string): Promise<JsonValue>;
  };
  /** Optional MCP read tools exposed to the agent (name -> invoker). */
  readonly mcpReadTools?: Readonly<Record<string, { readonly description: string; readonly inputSchema: JsonValue; readonly call: (args: Readonly<Record<string, unknown>>) => Promise<JsonValue> }>>;
  readonly wake: WakePolicyConfig;
  readonly context: ContextBudget;
  /** Called when the mind's `finish` tool is used. */
  readonly onFinished: (success: boolean, summary: string) => void;
  /** Called when the mind wants the runtime to change state (e.g. pause). */
  readonly setState: (state: AgentState, detail?: string) => void;
}

export interface MindStatus {
  readonly turns: number;
  readonly lastWakeAt?: number;
  readonly lastReasons: readonly WakeReason[];
  readonly promptTokensEstimate: number;
  readonly historyMessages: number;
  readonly compactions: number;
  readonly busy: boolean;
}

/** The LLM-driven deliberation loop for one agent. */
export interface Mind {
  /** Request a wake; the implementation coalesces and rate-limits. Resolves when the resulting turn (if any) completes. */
  wake(reason: WakeReason, note?: string): Promise<void>;
  /** Announce a goal and schedule a `goal-assigned` wake. The runtime calls this once with `spec.goal` (`from: 'config'`) after start; minds must not self-wake for `spec.goal`. */
  setGoal(goal: string, from: 'director' | 'coordinator' | 'operator' | 'config'): Promise<void>;
  /** Operator/coordinator/director message; triggers a `message` wake. */
  say(from: string, text: string): Promise<void>;
  status(): MindStatus;
  /** Full transcript (post-compaction) for the TUI. */
  transcript(): readonly import('./model.ts').ChatMessage[];
  dispose(): Promise<void>;
}

export type MindFactory = (deps: MindDeps) => Mind;

/** What the runtime exposes about one agent to the director, coordinators, and the TUI. */
export interface AgentHandle {
  readonly id: AgentId;
  readonly spec: AgentSpec;
  readonly tag: string;
  readonly entity: number;
  readonly team?: TeamId;
  readonly state: AgentState;
  readonly goal?: string;
  readonly view: WorldView;
  readonly reflexes: ReflexEngine;
  readonly mind: Mind;
  readonly memory: MemoryStore;
  readonly mailbox: Mailbox;
  setGoal(goal: string, from: 'director' | 'coordinator' | 'operator'): Promise<void>;
  pause(reason?: string, opts?: PauseOptions): void;
  resume(): void;
  /** Short status line for tables/prompts: state, hp, position, activity, behaviour, goal. */
  summary(): string;
}
