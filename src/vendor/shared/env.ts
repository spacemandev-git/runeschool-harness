import type { EntityId, NpcConfigId } from './ids.ts';
import type { Tick } from './coords.ts';
import type { RewardTerm } from './reward.ts';
import type { ScenarioDoc } from './scenario.ts';
import type {
  ActionRecord,
  JsonValue,
  PovSpec,
  SimBackend,
  SimCommandBase,
  SimEventEnvelope,
  SimHook,
  Snapshot,
  WorldState
} from './sim.ts';

/**
 * RL environment contract v1 (see ADR-0020).
 *
 * L2 is pure: everything here is a function of L1's WorldState / ActionRecord /
 * SimEventEnvelope. No game internals, no I/O, no engine imports. That is what
 * makes it swappable and what lets the same EnvSpec run against the real
 * simulation or a learned world model.
 *
 * The unit of configuration is an EnvSpec: it binds a world, a seeding policy,
 * and one or more agent GROUPS, each with its own observation encoder, action
 * space, reward function, point of view and horizon.
 */

export const ENV_SPEC_VERSION = 1;

/** Re-exported for convenience; defined in reward.ts so scenario.ts can share it. */
export type { RewardTerm };

/** Scenario actor tag, e.g. 'hero'. */
export type ActorTag = string;
/** EnvSpec-local group name, e.g. 'attackers'. */
export type GroupId = string;
export type EpisodeOutcome = 'won' | 'lost' | 'truncated';

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** What an encoder is handed. `state` is already POV-filtered for the actor. */
export interface ObsInput {
  readonly state: WorldState;
  readonly actor: EntityId;
  readonly actorTag?: ActorTag;
  readonly tick: Tick;
  /** Events visible to this actor since the previous observation. */
  readonly events: readonly SimEventEnvelope[];
  /** This actor's own commands since the previous observation, incl. rejections. */
  readonly actions: readonly ActionRecord[];
  /** Steps elapsed in this episode. */
  readonly stepIndex: number;
}

/**
 * Pure WorldState -> observation. Encoders are the main extension point for
 * people bringing their own model: text for LLMs, tensors for pixel/grid nets,
 * graphs for GNNs.
 */
export interface ObsEncoder<TObs = unknown> {
  readonly name: string;
  encode(input: ObsInput): TObs;
  /** Optional JSON Schema / shape descriptor for tooling and dataset writers. */
  describe?(): JsonValue;
  /** Reset any per-episode encoder memory (frame stacks, deltas). */
  reset?(): void;
}

// ---------------------------------------------------------------------------
// Action space
// ---------------------------------------------------------------------------

export interface ActionContext {
  readonly state: WorldState;
  readonly actor: EntityId;
  readonly actorTag?: ActorTag;
  readonly tick: Tick;
}

/** A decode failure that should be surfaced to the policy, not thrown. */
export interface ActionDecodeError {
  readonly code: string;
  readonly message: string;
}

export type ActionDecodeResult =
  | { readonly ok: true; readonly commands: readonly SimCommandBase[] }
  | { readonly ok: false; readonly error: ActionDecodeError };

/**
 * Maps a policy's output onto simulation commands. Implementations range from a
 * flat discrete index, to a tool-call JSON object, to free text parsed by regex.
 */
export interface ActionSpace<TAction = unknown> {
  readonly name: string;
  decode(action: TAction, ctx: ActionContext): ActionDecodeResult;
  /** Optional legality mask; index-aligned with a discrete space's enumeration. */
  mask?(ctx: ActionContext): readonly boolean[];
  /** Optional enumeration for discrete spaces. */
  enumerate?(ctx: ActionContext): readonly TAction[];
  describe?(): JsonValue;
}

// ---------------------------------------------------------------------------
// Reward
// ---------------------------------------------------------------------------

export interface RewardInput {
  readonly prev: WorldState;
  readonly next: WorldState;
  readonly actor: EntityId;
  readonly actorTag?: ActorTag;
  readonly group: GroupId;
  /** Members of this actor's group, for team/shared rewards. */
  readonly groupActors: readonly EntityId[];
  readonly events: readonly SimEventEnvelope[];
  readonly actions: readonly ActionRecord[];
  readonly tick: Tick;
  readonly stepIndex: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
}

/**
 * Pure scoring. `score` is called once per group member per env step.
 * Stateful shaping (potential-based, running baselines) is allowed via `reset`.
 */
export interface RewardFn {
  readonly name: string;
  score(input: RewardInput): number;
  /** Optional per-term decomposition for logging and debugging. */
  breakdown?(input: RewardInput): Readonly<Record<string, number>>;
  reset?(): void;
}


// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export interface TerminationInput {
  readonly state: WorldState;
  readonly tick: Tick;
  readonly stepIndex: number;
}

export interface TerminationVerdict {
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly reason?: string;
}

export interface TerminationPolicy {
  readonly name: string;
  evaluate(input: TerminationInput): TerminationVerdict;
}

// ---------------------------------------------------------------------------
// Groups and multi-agent interaction
// ---------------------------------------------------------------------------

/** Which entities a group covers. */
export type GroupMembership =
  | { readonly kind: 'tags'; readonly tags: readonly ActorTag[] }
  | { readonly kind: 'all-players' }
  | { readonly kind: 'entities'; readonly entities: readonly EntityId[] };

export interface GroupSpec<TObs = unknown, TAction = unknown> {
  readonly members: GroupMembership;
  readonly observation: ObsEncoder<TObs> | string;
  readonly actions: ActionSpace<TAction> | string;
  readonly reward: RewardFn | readonly RewardTerm[] | string;
  /** Default { kind: 'full' }. */
  readonly pov?: PovSpec;
  /** Simulation ticks advanced per env step for this group. Default 1. */
  readonly ticksPerStep?: number;
  readonly horizon?: { readonly maxSteps: number; readonly onExhaust: 'truncate' | 'lose' };
  /** Extra hooks scoped to this group. */
  readonly hooks?: readonly SimHook[];
}

/** How groups relate. Applied after per-group rewards are computed. */
export type MultiAgentPolicy =
  | { readonly kind: 'independent' }
  | { readonly kind: 'shared'; readonly groups: readonly GroupId[] }
  | { readonly kind: 'zero-sum'; readonly groups: readonly [GroupId, GroupId] }
  | { readonly kind: 'team-sum'; readonly teams: Readonly<Record<string, readonly GroupId[]>> }
  | { readonly kind: 'custom'; readonly ref: string; readonly config?: JsonValue };

// ---------------------------------------------------------------------------
// EnvSpec
// ---------------------------------------------------------------------------

export type WorldRef =
  | { readonly kind: 'scenario'; readonly scenarioId: string }
  | { readonly kind: 'scenario-doc'; readonly doc: ScenarioDoc }
  | { readonly kind: 'sandbox'; readonly regions: readonly number[] };

export type SeedPolicy =
  | { readonly kind: 'fixed'; readonly seeds: readonly number[] }
  | { readonly kind: 'range'; readonly from: number; readonly count: number }
  | { readonly kind: 'scenario-default' };

export interface RecordPolicy {
  /** Emit (s, a, s', r, done) tuples through the transition sink. */
  readonly transitions?: boolean;
  /** Take a Snapshot every N env steps; enables branching and MPC eval. */
  readonly snapshotEvery?: number;
  /** Include rejected commands in recorded transitions. Default true. */
  readonly includeRejected?: boolean;
  /** Include full WorldState (large) vs. observation only. Default false. */
  readonly fullState?: boolean;
}

/**
 * The single declarative object that binds a world, a seeding policy and a set
 * of agent groups into a runnable RL environment. Register one and it becomes
 * available by id to every harness adapter.
 */
export interface EnvSpec {
  readonly id: string;
  readonly specVersion: number;
  readonly description?: string;
  readonly world: WorldRef;
  readonly seeding: SeedPolicy;
  readonly groups: Readonly<Record<GroupId, GroupSpec>>;
  readonly interaction?: MultiAgentPolicy;
  readonly termination?: TerminationPolicy | string;
  readonly record?: RecordPolicy;
  readonly hooks?: readonly SimHook[];
  /** Free-form labels: difficulty, domain, split. Used by curricula and eval. */
  readonly tags?: Readonly<Record<string, JsonValue>>;
  /** Runtime knobs passed through to the SimBackend. */
  readonly runtime?: { readonly headless?: boolean; readonly eventCapacity?: number };
}

// ---------------------------------------------------------------------------
// The Env runtime interface
// ---------------------------------------------------------------------------

export interface EnvResetOptions {
  readonly seed?: number;
  /** Start from a snapshot instead of tick 0 (branching, MPC, resume). */
  readonly snapshot?: Snapshot;
}

/** Per-actor maps. Single-agent specs still return a one-key record. */
export type ByActor<T> = Readonly<Record<ActorTag, T>>;

export interface EnvResetResult<TObs = unknown> {
  readonly obs: ByActor<TObs>;
  readonly info: ByActor<EnvInfo>;
  readonly seed: number;
}

export interface EnvInfo {
  readonly tick: Tick;
  readonly stepIndex: number;
  readonly group: GroupId;
  readonly actor: EntityId;
  readonly legal?: readonly boolean[];
  readonly rewardBreakdown?: Readonly<Record<string, number>>;
  /** Rejections this step, so an LLM policy can self-correct. */
  readonly rejected?: readonly { readonly code: string; readonly message: string }[];
  readonly metrics?: Readonly<Record<string, number>>;
}

export interface EnvStepResult<TObs = unknown> {
  readonly obs: ByActor<TObs>;
  readonly reward: ByActor<number>;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly info: ByActor<EnvInfo>;
  /** Present on terminal/truncated steps, after scenario teams are mapped to EnvSpec groups. */
  readonly outcomesByGroup?: Readonly<Record<GroupId, EpisodeOutcome>>;
  /** Set when the episode ended this step. */
  readonly endReason?: string;
}

/** The gym-shaped surface. Async so HTTP and in-process backends look identical. */
export interface Env<TObs = unknown, TAction = unknown> {
  readonly spec: EnvSpec;
  readonly backend: SimBackend;
  reset(options?: EnvResetOptions): Promise<EnvResetResult<TObs>>;
  step(actions: ByActor<TAction>): Promise<EnvStepResult<TObs>>;
  /** Underlying simulation snapshot; restore via reset({ snapshot }). */
  snapshot(): Snapshot;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Transitions (model-based RL)
// ---------------------------------------------------------------------------

/**
 * One recorded transition. `state`/`next` are present only when
 * RecordPolicy.fullState is set; otherwise use `obs`/`nextObs`.
 */
export interface Transition<TObs = unknown, TAction = unknown> {
  readonly envSpec: string;
  readonly envSpecHash: string;
  readonly seed: number;
  readonly episode: number;
  readonly stepIndex: number;
  readonly tick: Tick;
  readonly actor: EntityId;
  readonly actorTag?: ActorTag;
  readonly group: GroupId;
  readonly obs: TObs;
  readonly action: TAction;
  readonly commands: readonly ActionRecord[];
  readonly nextObs: TObs;
  readonly reward: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly events: readonly SimEventEnvelope[];
  readonly state?: WorldState;
  readonly next?: WorldState;
  readonly snapshot?: Snapshot;
}

export interface TransitionSink {
  readonly name: string;
  write(transition: Transition): void | Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Named module registries. Users register their own encoders, rewards, action
 * spaces and specs; EnvSpec fields accept either an instance or a registered
 * name, so specs stay JSON-serializable when they need to be.
 */
export interface EnvRegistry {
  registerEnv(spec: EnvSpec): void;
  registerObsEncoder(encoder: ObsEncoder): void;
  registerActionSpace(space: ActionSpace): void;
  registerReward(reward: RewardFn): void;
  registerTermination(policy: TerminationPolicy): void;
  listEnvs(filter?: { readonly tag?: string; readonly value?: JsonValue }): readonly EnvSpec[];
  getEnv(id: string): EnvSpec | undefined;
}
