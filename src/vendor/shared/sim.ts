import type { EntityId, EntityKind, InstanceId, ItemConfigId, LocConfigId, NpcConfigId, SkillName } from './ids.ts';
import type { TileCoord, Tick } from './coords.ts';
import type { ScenarioDoc } from './scenario.ts';

/**
 * Simulation state contract v1 (see ADR-0019).
 *
 * This file defines the L1 boundary: the complete, serializable, deterministic
 * state of one simulation timeline, plus the action log and hook surface.
 *
 * The governing invariant is the MARKOV PROPERTY:
 *
 *     snapshot(A) -> step -> snapshot(B)
 *     restore(A)  -> step -> snapshot(B')
 *     assert deepEqual(B, B')
 *
 * If that fails, some mutable state is missing from WorldState and the sim is
 * not usable as a world-model training target. `packages/sim` owns the test.
 *
 * Everything here MUST be JSON-serializable: no functions, no classes, no
 * bigint, no Map/Set, no undefined-vs-missing ambiguity in arrays. bigint RNG
 * state is carried as a 0x-prefixed lowercase hex string.
 */

/** Bumped whenever WorldState's shape changes incompatibly. */
export const SIM_STATE_VERSION = 1;

/** JSON value. State slices must serialize to this. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Identity and provenance
// ---------------------------------------------------------------------------

/** Everything needed to recreate a simulation from tick 0. Content-addressable. */
export type SimOrigin =
  | {
      readonly kind: 'scenario';
      readonly seed: number;
      /** Inline document. Hosts that store scenarios may carry `scenarioId` too. */
      readonly scenario: ScenarioDoc;
      readonly scenarioId?: string;
      /** Archived run id whose actor state seeds this one (quest chains). */
      readonly continueFrom?: string;
    }
  | {
      readonly kind: 'sandbox';
      readonly seed: number;
      readonly regions: readonly number[];
    }
  | { readonly kind: 'blank'; readonly seed: number };

/** Root RNG state. Forked streams are serialized inside their owning system slice. */
export interface RngState {
  /** 0x-prefixed lowercase hex of the 48-bit LCG state. */
  readonly state: string;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * A scheduled pulse as plain data. `pulseId` names a behaviour registered on the
 * instance's pulse registry at construction time; `args` is the pulse's own
 * serializable payload. Function references are NOT part of the state.
 */
export interface ScheduledPulseState {
  readonly pulseId: string;
  readonly args: JsonValue;
  readonly delay: number;
  readonly dueTick: Tick;
  /** Submission order; ties within a dueTick resolve by ascending seq. */
  readonly seq: number;
}

export interface SchedulerState {
  readonly currentTick: Tick;
  /**
   * In FIRING order: ascending `dueTick`, and within a tick, the live queue
   * order the scheduler would actually execute.
   *
   * Deliberately not sorted by `seq`. Arrival order and seq order diverge once
   * `setDelay` makes an older pulse collide with a newer one's due tick, and
   * the queue's arrival order is the behaviour every existing caller already
   * depends on. `seq` is identity here, not ordering.
   */
  readonly pulses: readonly ScheduledPulseState[];
  readonly nextSeq: number;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Entity identity and spatial state only. Per-entity gameplay data (skills,
 * inventory, equipment, combat, prayer) lives in the owning system's slice,
 * keyed by entity id. This keeps the state entity-factored AND system-factored,
 * which is what a learned world model needs.
 */
export interface EntityState {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly at: TileCoord;
  readonly npc?: NpcConfigId;
  readonly loc?: LocConfigId;
  readonly item?: ItemConfigId;
  readonly name?: string;
  /** Present for combatants. */
  readonly hp?: { readonly current: number; readonly max: number };
  /** Actor tag when this entity fills a scenario actor slot. */
  readonly actorTag?: string;
}

// ---------------------------------------------------------------------------
// System state slices
// ---------------------------------------------------------------------------

/**
 * One system's serializable state. Systems own their own schema; `packages/sim`
 * only guarantees slice ordering (ascending `system`) and round-trip fidelity.
 *
 * ORDERING RULE (this bit is easy to get wrong):
 * "Deterministic" means REPRODUCIBLE, not SORTED. Where a collection's iteration
 * order is semantically observable -- active prayers drain in activation order,
 * shop player-stock displays in sale order, fires expire in creation order --
 * capture it VERBATIM. Sorting such a collection makes two captures of one
 * object compare equal while changing the behaviour restore produces, which is
 * strictly worse than not sorting at all. Sort only collections whose order is
 * genuinely incidental, and say which is which in the system's docs.
 *
 * RNG RULE: a system that draws randomness MUST own a capturable `Rng` and
 * serialize its state here. Taking an opaque `randInt` closure over a fork the
 * system does not own leaves the stream uncapturable, and restore then silently
 * continues on a different random sequence. If a system cannot capture its RNG,
 * it must say so through `hasUncapturedRandomness()` so the layer above can
 * REFUSE to snapshot -- exactly as `Scheduler.hasOpaquePulses()` does. Silent
 * divergence is the one failure mode this whole contract exists to prevent.
 */
export interface StateSlice {
  /** Stable system name, e.g. 'combat', 'items', 'skills', 'npcai'. */
  readonly system: string;
  /** Bumped when this system's slice shape changes. */
  readonly version: number;
  readonly data: JsonValue;
}

/**
 * Contract every stateful system implements so `packages/sim` can snapshot and
 * restore it without knowing its internals. Implementations must be exact:
 * `restoreState(captureState())` is the identity.
 */
export interface StatefulSystem {
  readonly stateName: string;
  readonly stateVersion: number;
  captureState(): JsonValue;
  restoreState(data: JsonValue, version: number): void;
  /**
   * True when this system draws randomness it cannot serialize (e.g. it was
   * constructed with an opaque `randInt` closure instead of an owned `Rng`).
   * `packages/sim` must refuse a `kind: 'state'` snapshot while any system
   * reports true, and fall back to a replay snapshot instead.
   */
  hasUncapturedRandomness?(): boolean;
}

// ---------------------------------------------------------------------------
// Objectives / scoring-relevant state
// ---------------------------------------------------------------------------

/**
 * Per-condition-leaf progress. Previously private to ConditionTracker; exposed
 * because it is the cheapest dense progress signal in the system.
 */
export interface ConditionProgress {
  /** Stable path into the objective's condition tree, e.g. 'all.0', 'any.1.all.0'. */
  readonly path: string;
  readonly kind: 'kill' | 'obtain' | 'reach' | 'skill-level' | 'event' | 'tick' | 'survivors' | 'eliminated' | 'vote';
  readonly current: number;
  readonly target: number;
  readonly satisfied: boolean;
  readonly actorTag?: string;
}

export interface ObjectiveState {
  readonly objectives: readonly {
    readonly id: string;
    readonly description: string;
    readonly outcome: 'win' | 'lose' | 'progress';
    readonly actorTag?: string;
    readonly team?: string;
    readonly complete: boolean;
    /** Flattened leaves of this objective's condition tree, in tree order. */
    readonly progress: readonly ConditionProgress[];
    readonly killTargets?: readonly NpcConfigId[];
  }[];
  readonly won: boolean;
  readonly lost: boolean;
  /** Scenario-team terminal state in authored team order. */
  readonly teams?: Readonly<Record<string, 'won' | 'lost' | 'open'>>;
  /** Tick budget exhausted. Distinct from `lost`: truncation is not a failure. */
  readonly truncated: boolean;
  readonly firedTriggers: readonly string[];
  readonly nextScenario?: string;
  readonly chain?: { readonly id: string; readonly stage: number };
}

// ---------------------------------------------------------------------------
// WorldState
// ---------------------------------------------------------------------------

export type SimStatus = 'running' | 'ended';

export interface WorldMeta {
  readonly origin: SimOrigin;
  readonly map:
    | { readonly kind: 'world-regions'; readonly regions: readonly number[] }
    | {
        readonly kind: 'composite';
        /** One entry per placed copy; `key` disambiguates repeated `regionId`s. */
        readonly regions: readonly {
          readonly key: string;
          readonly regionId: number;
          readonly baseX: number;
          readonly baseZ: number;
        }[];
      }
    | { readonly kind: 'custom'; readonly width: number; readonly height: number; readonly origin: TileCoord };
}

/** The complete state of one simulation timeline at one tick. */
export interface WorldState {
  readonly stateVersion: number;
  readonly instance: InstanceId;
  readonly tick: Tick;
  readonly status: SimStatus;
  readonly endReason?: string;
  readonly meta: WorldMeta;
  readonly rng: RngState;
  readonly scheduler: SchedulerState;
  readonly entities: readonly EntityState[];
  /** actorTag -> entity id. */
  readonly actors: Readonly<Record<string, EntityId>>;
  /** Ascending by `system`. */
  readonly systems: readonly StateSlice[];
  readonly objectives?: ObjectiveState;
  /**
   * Set when this state was produced by `stateFor(actor, pov)` rather than
   * `state()`. A filtered state is NOT restorable and MUST NOT be snapshotted.
   */
  readonly pov?: { readonly actor: EntityId; readonly spec: PovSpec };
}

// ---------------------------------------------------------------------------
// Point of view (partial observability). Core capability; policy is L2 config.
// ---------------------------------------------------------------------------

export type PovSpec =
  | { readonly kind: 'full' }
  | {
      readonly kind: 'radius';
      /** Chebyshev tiles. */
      readonly tiles: number;
      /** Default true: entities on other levels are hidden. */
      readonly sameLevelOnly?: boolean;
    }
  | {
      readonly kind: 'los';
      readonly tiles: number;
      /** Default true: also apply the roofed/inside-building rule. */
      readonly respectRoofs?: boolean;
    };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * A command as the simulation sees it: the wire envelope minus transport fields
 * (`instance`, client `id`). `packages/shared/src/simCommands.ts` refines
 * `SimCommand` into a discriminated union over all command types.
 */
export interface SimCommandBase {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Who issued a command. */
export type SimActorRef =
  | { readonly role: 'actor'; readonly entity: EntityId; readonly tag?: string }
  | { readonly role: 'admin' };

/**
 * One entry in the command log. Rejected commands are logged too: a world model
 * must learn that illegal actions are no-ops, and an RL policy needs the reason.
 */
export interface ActionRecord {
  readonly tick: Tick;
  /** Total order within the instance, monotonic from 1. */
  readonly seq: number;
  readonly by: SimActorRef;
  readonly command: SimCommandBase;
  readonly accepted: boolean;
  /** Machine-readable rejection code when accepted=false. */
  readonly error?: string;
  /** Human/LLM-readable explanation when accepted=false. */
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Phase 1 ('replay') works with only the command log and costs O(tick) to
 * restore. Phase 2 ('state') is O(1). Both are exact, because the simulation is
 * deterministic given (origin, ordered commands).
 */
export type Snapshot =
  | {
      readonly kind: 'state';
      readonly stateVersion: number;
      readonly state: WorldState;
    }
  | {
      readonly kind: 'replay';
      readonly stateVersion: number;
      readonly origin: SimOrigin;
      readonly toTick: Tick;
      readonly commands: readonly ActionRecord[];
    };

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/**
 * Raw result of advancing the simulation. Deliberately carries NO observation
 * and NO reward: those are L2 (`packages/env`) concerns computed from state.
 */
export interface StepResult {
  readonly fromTick: Tick;
  readonly tick: Tick;
  /** Events emitted during this step, in emission order. */
  readonly events: readonly SimEventEnvelope[];
  /** Commands applied during this step, in application order. */
  readonly commands: readonly ActionRecord[];
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly endReason?: string;
}

/** Transport-independent event envelope. `packages/shared/src/simEvents.ts` types `data`. */
export interface SimEventEnvelope {
  readonly type: string;
  readonly tick: Tick;
  readonly seq: number;
  readonly data: unknown;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Read-only view handed to hooks. Hooks MUST NOT mutate simulation state;
 * doing so breaks determinism and therefore breaks snapshots.
 */
export interface SimHookContext {
  readonly instance: InstanceId;
  readonly tick: Tick;
  /** Full, unfiltered state. Cached per tick by the runtime. */
  state(): WorldState;
  /** Filtered state for one actor. */
  stateFor(actor: EntityId, pov?: PovSpec): WorldState;
  /** Record a named scalar for this tick; surfaced in StepResult metrics. */
  metric(name: string, value: number): void;
}

export interface SimHook {
  readonly name: string;
  onEpisodeStart?(ctx: SimHookContext): void;
  onTickStart?(ctx: SimHookContext): void;
  onCommand?(ctx: SimHookContext, record: ActionRecord): void;
  onEvent?(ctx: SimHookContext, event: SimEventEnvelope): void;
  onTickEnd?(ctx: SimHookContext): void;
  onEpisodeEnd?(ctx: SimHookContext, reason: string): void;
}

// ---------------------------------------------------------------------------
// The backend interface
// ---------------------------------------------------------------------------

/** Runtime knobs that do not affect simulation semantics. */
export interface SimRuntimeOptions {
  /** Skip SQLite archival and unbounded in-memory event retention. Default false. */
  readonly headless?: boolean;
  /** Event ring capacity. Default 65_536. */
  readonly eventCapacity?: number;
  /** Hard tick budget; exceeding it sets `truncated`. */
  readonly maxTicks?: number;
  /** Retain the command log for snapshots. Default true. */
  readonly recordCommands?: boolean;
}

/**
 * The L1 contract. `packages/sim` implements it over the real engine; a learned
 * world model implements the same interface so `packages/env` can swap between
 * ground truth and a model without any policy-side change.
 */
export interface SimBackend {
  readonly instance: InstanceId;
  readonly tick: Tick;
  readonly status: SimStatus;

  state(): WorldState;
  stateFor(actor: EntityId, pov?: PovSpec): WorldState;

  /** Apply one command immediately; it takes effect on the current tick. */
  apply(command: SimCommandBase, by: SimActorRef): CommandOutcome;

  /** Advance `ticks` (default 1) and return everything that happened. */
  step(ticks?: number): StepResult;

  snapshot(): Snapshot;
  /** Restore in place. Throws on stateVersion mismatch. */
  restore(snapshot: Snapshot): void;
  /** Independent copy sharing no mutable state. */
  fork(): SimBackend;

  addHook(hook: SimHook): void;
  removeHook(name: string): boolean;

  end(reason: string): void;
  close(): void;
}

/** Result of `apply`. Mirrors the wire CommandResult minus transport fields. */
export interface CommandOutcome {
  readonly ok: boolean;
  readonly tick: Tick;
  readonly error?: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  /** Log seq assigned to this command. */
  readonly seq: number;
}
