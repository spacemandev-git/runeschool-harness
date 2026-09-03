import type { TileCoord } from './coords.ts';
import type { EntityId, EntityKind, InstanceId } from './ids.ts';
import type { PlacementView } from './admin.ts';
import type {
  CompositeMap,
  MapRef,
  RegionLink,
  RegionPlacement
} from './scenario.ts';
import type { JsonValue } from './sim.ts';

/**
 * The living-world contracts (ADR 0027): chunked activation of a very large composite, mutation of
 * a RUNNING instance's map, and persistence of dynamic world state.
 *
 * A **chunk is exactly one placed 64x64 map square**, identified by its placement key. That choice
 * is deliberate: collision zones, region GLBs, the region index, and NPC spawn tables are all
 * already region-granular, so no other granularity would line up with the data we have.
 *
 * Keep every type in this file JSON-serializable.
 */

// ---------------------------------------------------------------------------
// Chunked activation
// ---------------------------------------------------------------------------

/** A chunk is active (simulating) or dormant (frozen, still in memory). */
export type ChunkState = 'active' | 'dormant';

export interface ChunkView {
  /** The placement key of this copy; unique even when the same regionId is placed twice. */
  readonly key: string;
  readonly regionId: number;
  readonly baseX: number;
  readonly baseZ: number;
  readonly state: ChunkState;
  /** Player entities currently inside this chunk. */
  readonly players: number;
  /** NPCs inside it — live while active, frozen while dormant. */
  readonly npcs: number;
  /**
   * Why the chunk is active: `occupied` holds a player, `ring` is within `radius` of one.
   * Absent while dormant.
   */
  readonly reason?: 'occupied' | 'ring' | 'pinned';
}

export interface ActiveChunksResponse {
  /** Ring radius in chunks around each occupied chunk. 1 means a 3x3 active block. */
  readonly radius: number;
  readonly activeKeys: readonly string[];
  readonly chunks: readonly ChunkView[];
  /** Chunks kept active regardless of occupancy, e.g. a persistent town. */
  readonly pinned: readonly string[];
}

/**
 * Activation policy for one instance. `radius` 0 activates only occupied chunks; the default of 1
 * gives a 3x3 block so a player never walks into an unsimulated chunk. `maxActive` bounds the
 * simulated set regardless of how many players spread out — the least recently occupied chunks
 * deactivate first.
 */
export interface ChunkPolicy {
  readonly radius?: number; // default 1, max 4
  readonly maxActive?: number; // default 64
  /** Placement keys that never deactivate. */
  readonly pinned?: readonly string[];
}

export interface ChunkPolicyRequest {
  readonly policy: ChunkPolicy;
}

// ---------------------------------------------------------------------------
// Live map mutation
// ---------------------------------------------------------------------------

/**
 * One change to a RUNNING instance's composite map. Adding a placement builds that copy's collision
 * immediately; removing one drops its collision, freezes nothing and destroys its NPCs, and is
 * rejected while any player stands inside it.
 */
export type MapMutation =
  | { readonly kind: 'add-placement'; readonly placement: RegionPlacement }
  | { readonly kind: 'remove-placement'; readonly key: string }
  | { readonly kind: 'add-link'; readonly link: RegionLink }
  | { readonly kind: 'remove-link'; readonly id: string };

/** Applied in order and atomically: if one fails, none are applied. */
export interface MapMutationRequest {
  readonly mutations: readonly MapMutation[];
}

export interface MapMutationResponse {
  readonly applied: number;
  /** The instance's composite map after the batch. */
  readonly composite: CompositeMap;
  readonly chunks: ActiveChunksResponse;
}

// ---------------------------------------------------------------------------
// Persistence of dynamic world state
// ---------------------------------------------------------------------------

/** One system's captured slice, as produced by `StatefulSystem.captureState`. */
export interface CapturedSystemState {
  readonly stateName: string;
  readonly stateVersion: number;
  readonly data: JsonValue;
}

export interface PersistedEntity {
  readonly entity: EntityId;
  readonly kind: EntityKind;
  readonly at: TileCoord;
  readonly npcConfigId?: number;
  readonly locConfigId?: number;
  readonly actorTag?: string;
  readonly health?: number;
}

export interface WorldSnapshotMeta {
  readonly id: string; // kebab-case slug
  readonly name: string;
  readonly instanceId: InstanceId;
  readonly tick: number;
  readonly seed: string;
  readonly createdAt: number;
  /** Must equal `SIM_STATE_VERSION` to be restorable. */
  readonly stateVersion: number;
  readonly entityCount: number;
  readonly placementCount: number;
}

/**
 * A complete, restorable dynamic world: its map (including any live mutations), every runtime
 * placement, every entity, and every stateful system's captured slice.
 *
 * This is deliberately NOT the scenario document. A scenario says how a world STARTS; a snapshot
 * says what a world BECAME. Restoring one produces an instance that continues rather than restarts.
 */
export interface WorldSnapshot {
  readonly meta: WorldSnapshotMeta;
  readonly map: MapRef;
  readonly placements: readonly PlacementView[];
  readonly entities: readonly PersistedEntity[];
  readonly systems: readonly CapturedSystemState[];
  readonly chunkPolicy?: ChunkPolicy;
  /**
   * Frozen NPCs of every DORMANT chunk, keyed by placement key.
   *
   * Without this a snapshot would silently break the freeze-keeps-state guarantee: a wounded NPC
   * in a chunk the player had walked away from would come back at full health from the spawn
   * table. In a large world most chunks are dormant most of the time, so this is the common case
   * rather than an edge case.
   *
   * Chunks absent from this map have never been visited and are re-seeded from the spawn table on
   * resume, which is correct — they have no accumulated state to lose.
   */
  readonly dormantChunks?: Readonly<Record<string, readonly PersistedDormantNpc[]>>;
}

/**
 * One frozen NPC awaiting reactivation. Mirrors the server's `DormantNpc`; `anchor` is its
 * wander origin, which is NOT always the tile it froze at.
 */
export interface PersistedDormantNpc {
  readonly npc: number;
  readonly at: TileCoord;
  readonly anchor: TileCoord;
  readonly wanderRadius: number;
  readonly respawnTicks?: number;
  readonly behavior: { readonly retaliate: boolean; readonly aggroRadius: number };
  /** Health when it froze; omitted means full health. */
  readonly health?: number;
}

export interface WorldSnapshotSummary {
  readonly id: string;
  readonly name: string;
  readonly tick: number;
  readonly createdAt: number;
  readonly stateVersion: number;
  readonly entityCount: number;
  readonly placementCount: number;
  readonly mapKind: MapRef['kind'];
  /** False when `stateVersion` no longer matches this build; such a snapshot cannot be resumed. */
  readonly restorable: boolean;
}

export interface WorldSnapshotListResponse {
  readonly snapshots: readonly WorldSnapshotSummary[];
}

/** `POST /instances/:id/snapshot` — capture the running world under a reusable id. */
export interface CreateWorldSnapshotRequest {
  readonly id: string;
  readonly name?: string;
  readonly overwrite?: boolean;
}

/** `POST /instances` with `resumeSnapshot` — rebuild an instance from a stored snapshot. */
export interface ResumeWorldSnapshotRequest {
  readonly resumeSnapshot: string;
  readonly realtime?: boolean;
}
