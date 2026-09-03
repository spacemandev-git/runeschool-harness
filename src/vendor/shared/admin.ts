import type { TileCoord } from './coords.ts';
import type { EntityId, ItemConfigId, LocConfigId, NpcConfigId, SkillName } from './ids.ts';
import type {
  CompositeMap,
  CustomMap,
  NpcBehavior,
  PortalLink,
  RegionLink,
  TerrainKind
} from './scenario.ts';

/**
 * Dynamic world-authoring API (see ADR 0023). Every request in this file mutates a RUNNING
 * instance and requires the instance admin token in `Authorization: Bearer <token>`.
 *
 * These are deliberately shaped like their scenario-time equivalents (`NpcSpawn`, `LocSpawn`,
 * `GroundItemSpawn`, `NodeSpawn`) so an author can move a placement between a scenario document
 * and a live call without reshaping it. The differences are that runtime placements carry no
 * scenario `tag` semantics for triggers, and every accepted placement gets a server-assigned
 * `PlacementId` used to remove it again.
 *
 * Keep every type in this file JSON-serializable.
 */

/** Server-assigned handle for one runtime placement. Stable for the instance's lifetime. */
export type PlacementId = string;

export type PlacementKind =
  | 'npc'
  | 'loc'
  | 'ground-item'
  | 'node'
  | 'terrain'
  | 'portal';

/** Spawn one NPC. Mirrors `NpcSpawn` minus the trigger-facing `tag`. */
export interface NpcPlacementRequest {
  readonly npc: NpcConfigId;
  readonly at: TileCoord;
  readonly wanderRadius?: number;
  readonly respawnTicks?: number;
  readonly behavior?: NpcBehavior;
  /** Key into the instance scenario's `lootTables`; ignored when that table is absent. */
  readonly loot?: string;
  /** Optional display label surfaced in entity metadata. */
  readonly label?: string;
}

/**
 * Place one loc: scenery, furniture, a building, a portal frame, anything with a 530 loc config.
 * `blocking` defaults to the loc definition's own clip type; set it false to place a purely
 * decorative copy that does not touch collision.
 */
export interface LocPlacementRequest {
  readonly loc: LocConfigId;
  readonly at: TileCoord;
  readonly rotation?: 0 | 1 | 2 | 3;
  readonly shape?: number; // 530 LocShape; default 10 (CENTREPIECE_STRAIGHT)
  readonly blocking?: boolean;
  readonly label?: string;
}

/** Drop one item stack. Mirrors `GroundItemSpawn`. */
export interface GroundItemPlacementRequest {
  readonly item: ItemConfigId;
  readonly amount: number;
  readonly at: TileCoord;
  readonly respawnTicks?: number;
}

/** Register one gathering node. Mirrors `NodeSpawn` minus the trigger-facing `tag`. */
export interface NodePlacementRequest {
  readonly at: TileCoord;
  readonly skill: SkillName;
  readonly requiredLevel: number;
  readonly xp: number;
  readonly yieldItem: ItemConfigId;
  readonly successLow: number;
  readonly successHigh: number;
  readonly depleteChance?: number;
  readonly respawnTicks?: number;
  /** Loc config id used to render the node; falls back to the generic node marker. */
  readonly loc?: LocConfigId;
}

/**
 * Stamp a painted tile patch into a live instance. The patch is a `CustomMap` grid whose `origin`
 * is the south-west tile in instance coordinates; it overwrites walkability and visual style for
 * exactly the tiles it covers and leaves everything outside untouched.
 */
export interface TerrainPlacementRequest {
  readonly patch: CustomMap;
}

/** Create one portal link between two tiles. Mirrors `PortalLink` minus its authored `id`. */
export interface PortalPlacementRequest {
  readonly a: TileCoord;
  readonly b: TileCoord;
  readonly bidirectional?: boolean;
  readonly loc?: LocConfigId;
  readonly label?: string;
}

export type PlacementRequest =
  | ({ readonly kind: 'npc' } & NpcPlacementRequest)
  | ({ readonly kind: 'loc' } & LocPlacementRequest)
  | ({ readonly kind: 'ground-item' } & GroundItemPlacementRequest)
  | ({ readonly kind: 'node' } & NodePlacementRequest)
  | ({ readonly kind: 'terrain' } & TerrainPlacementRequest)
  | ({ readonly kind: 'portal' } & PortalPlacementRequest);

/** One accepted runtime placement, as returned by create and list. */
export interface PlacementView {
  readonly id: PlacementId;
  readonly kind: PlacementKind;
  /** Tick at which the placement was applied. */
  readonly tick: number;
  /** Present for placements that produced a live entity (`npc`, `loc`). */
  readonly entity?: EntityId;
  /** Present for `node`; the gathering node's runtime id. */
  readonly node?: string;
  /** Anchor tile. For `terrain` this is the patch origin. */
  readonly at: TileCoord;
  /** Echo of the accepted request, normalized. */
  readonly request: PlacementRequest;
}

export interface PlacementListResponse {
  readonly placements: readonly PlacementView[];
}

/** Batch form. Placements are applied in array order and the whole batch fails atomically. */
export interface PlacementBatchRequest {
  readonly placements: readonly PlacementRequest[];
}

export interface PlacementBatchResponse {
  readonly placements: readonly PlacementView[];
}

/** Result of removing one placement. */
export interface PlacementRemovedResponse {
  readonly id: PlacementId;
  readonly removed: true;
}

// ---------------------------------------------------------------------------
// Composite ("combined region") artifacts
// ---------------------------------------------------------------------------

/**
 * The resolved runtime view of a composite map, returned by `GET /instances/:id/map` for a
 * composite instance and by `GET /composites/:id/resolved`. `baseX`/`baseZ` are the PLACED base
 * tile of each copy — the renderer positions that copy's region GLB there directly.
 */
export interface ResolvedRegionPlacement {
  readonly key: string;
  readonly regionId: number;
  /** True base tile of the source square in the 530 world. */
  readonly sourceBaseX: number;
  readonly sourceBaseZ: number;
  /** Base tile of this copy inside the composite. */
  readonly baseX: number;
  readonly baseZ: number;
  readonly dx: number;
  readonly dz: number;
}

export interface ResolvedCompositeMap {
  readonly regions: readonly ResolvedRegionPlacement[];
  readonly links: readonly RegionLink[];
  /** Inclusive tile bounds covering every placed copy and link. */
  readonly bounds: {
    readonly minX: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxZ: number;
  };
}

export interface CompositeSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly regionCount: number;
  readonly linkCount: number;
  readonly spawn?: TileCoord;
}

/**
 * `GET /instances/:id/map` response. `world-regions` and `custom` keep their existing shapes;
 * `composite` is new.
 */
export type InstanceMapView =
  | { readonly kind: 'world-regions'; readonly regions: readonly number[] }
  | ({ readonly kind: 'composite' } & ResolvedCompositeMap)
  | {
      readonly kind: 'custom';
      readonly width: number;
      readonly height: number;
      readonly origin: TileCoord;
      readonly palette: Readonly<Record<string, {
        readonly walkable: boolean;
        readonly terrain: TerrainKind;
        readonly height: number;
      }>>;
      readonly defaultTile: {
        readonly walkable: boolean;
        readonly terrain: TerrainKind;
        readonly height: number;
      };
      readonly rows: readonly string[];
    };

/** Re-exported for consumers that build composites without importing the scenario module. */
export type { CompositeMap, PortalLink, RegionLink };

// ---------------------------------------------------------------------------
// Runtime entity mutation (admin)
// ---------------------------------------------------------------------------

/**
 * Admin-token-gated mutations of one LIVE entity, applied by
 * `POST /instances/:id/entities/:entityId/mutations`. These are the "game master" verbs that
 * placements cannot express: change what an actor carries, knows, or where it stands. Requests are
 * validated as a batch before anything is applied and then applied in array order; unlike
 * placements they carry no undo and are not listed afterwards — the ordinary entity events
 * (`item-added`, `item-removed`, `damaged`, `entity-moved`, ...) are the record.
 *
 * Keep every type in this file JSON-serializable.
 */

/** Add a stack to the entity's inventory. Partial adds are reported, not rejected. */
export interface GiveItemMutation {
  readonly kind: 'give-item';
  readonly item: ItemConfigId;
  readonly amount: number;
}

/** Remove up to `amount` of an item from the entity's inventory. */
export interface TakeItemMutation {
  readonly kind: 'take-item';
  readonly item: ItemConfigId;
  readonly amount: number;
}

/** Set one skill to an exact level (1–99). Combat stats and max hitpoints follow. */
export interface SetSkillMutation {
  readonly kind: 'set-skill';
  readonly skill: SkillName;
  readonly level: number;
}

/** Restore health; omit `amount` to heal to the entity's maximum. */
export interface HealMutation {
  readonly kind: 'heal';
  readonly amount?: number;
}

/** Apply non-combat damage through the canonical death lifecycle. */
export interface DamageMutation {
  readonly kind: 'damage';
  readonly amount: number;
}

/** Move the entity instantly to a walkable tile, cancelling any movement in progress. */
export interface TeleportMutation {
  readonly kind: 'teleport';
  readonly at: TileCoord;
}

export type EntityMutation =
  | GiveItemMutation
  | TakeItemMutation
  | SetSkillMutation
  | HealMutation
  | DamageMutation
  | TeleportMutation;

export type EntityMutationKind = EntityMutation['kind'];

/** Batch form. A single mutation object is also accepted by the route. */
export interface EntityMutationBatchRequest {
  readonly mutations: readonly EntityMutation[];
}

export type EntityMutationResult =
  | {
      readonly kind: 'give-item';
      readonly item: ItemConfigId;
      readonly requested: number;
      readonly added: number;
      readonly overflow: number;
    }
  | {
      readonly kind: 'take-item';
      readonly item: ItemConfigId;
      readonly requested: number;
      readonly removed: number;
    }
  | {
      readonly kind: 'set-skill';
      readonly skill: SkillName;
      readonly level: number;
      readonly previousLevel: number;
    }
  | { readonly kind: 'heal'; readonly health: number; readonly maxHealth: number }
  | { readonly kind: 'damage'; readonly health: number; readonly died: boolean }
  | { readonly kind: 'teleport'; readonly from: TileCoord; readonly to: TileCoord };

export interface EntityMutationBatchResponse {
  readonly entity: EntityId;
  /** Tick at which the batch was applied. */
  readonly tick: number;
  /** One result per accepted mutation, in request order. */
  readonly results: readonly EntityMutationResult[];
}

/** Result of `DELETE /instances/:id/entities/:entityId` (admin despawn of a non-player entity). */
export interface EntityDespawnedResponse {
  readonly entity: EntityId;
  readonly despawned: true;
}
