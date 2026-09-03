import type { NpcConfigId, ItemConfigId, LocConfigId, SkillName } from './ids.ts';
import type { TileCoord } from './coords.ts';
import type { RewardTerm } from './reward.ts';
import type { QuestDef } from './quests.ts';
import type { ZoneDef } from './zones.ts';

/**
 * Scenario DSL v0 (see ADR-0005). Declarative, LLM-authorable documents describing a
 * custom game: map, spawns, actors, dialogue, objectives, triggers, cinematics.
 * @runeschool/scenario owns the zod schema mirroring these types plus the validator/loader.
 * Keep these types JSON-serializable (no functions, no classes).
 */

export interface ScenarioDoc {
  readonly meta: ScenarioMeta;
  readonly map: MapRef;
  readonly seed?: number;
  /** Whether player entities may engage other player entities. Defaults to false. */
  readonly pvp?: boolean;
  readonly zones?: ZoneDef[];
  /**
   * Optional in-simulation tick budget. Reaching it TRUNCATES the episode
   * (`scenario-truncated`); it is deliberately not a loss. Without this,
   * truncation can only be faked client-side, which is not deterministic.
   */
  readonly maxTicks?: number;
  /**
   * Optional default reward rubric for this task. Declared here, evaluated by
   * `@runeschool/env` -- the scenario engine never computes reward. An EnvSpec
   * may override it, which is the point: the same task must be runnable with
   * sparse, dense, or no reward at all.
   */
  readonly rubric?: { readonly terms: readonly RewardTerm[] };
  /** Optional quest-chain identity and one-based stage number for this scenario. */
  readonly chain?: ScenarioChainRef;
  /** Optional scenario slug selected by the host after this scenario completes. */
  readonly nextScenario?: string;
  readonly spawns?: SpawnSet;
  readonly actors?: ActorSlot[];
  readonly dialogues?: DialogueTree[];
  readonly quests?: QuestDef[];
  readonly respawn?: ScenarioRespawnPolicy;
  readonly teams?: ScenarioTeam[];
  readonly objectives?: Objective[];
  readonly triggers?: Trigger[];
  readonly cinematics?: Cinematic[];
  /** Named loot tables, referenced by NpcSpawn.loot. */
  readonly lootTables?: Record<string, LootTable>;
}

/** Identifies a scenario's position in a host-resolved quest chain. */
export interface ScenarioChainRef {
  /** Stable lowercase slug shared by every scenario in the chain. */
  readonly id: string;
  /** One-based stage number within the chain. */
  readonly stage: number;
}

/** One weighted loot outcome. `amount` may be fixed or a uniform inclusive range. */
export interface LootEntry {
  readonly item: ItemConfigId;
  readonly amount: number | { readonly min: number; readonly max: number };
  readonly weight: number; // > 0
}

export interface LootTable {
  readonly entries: LootEntry[];
  /** Independent draws per kill. Default 1. */
  readonly rolls?: number;
  /** Weight of the "no drop" outcome added to each draw. Default 0. */
  readonly nothingWeight?: number;
}

/** Optional NPC combat behavior overrides (defaults: retaliate true, aggroRadius 0). */
export interface NpcBehavior {
  readonly retaliate?: boolean;
  readonly aggroRadius?: number; // chebyshev tiles; 0 = passive
  readonly dragonfire?: boolean;
}

export interface NpcStatOverrides {
  readonly hitpoints?: number;
  readonly attack?: number;
  readonly strength?: number;
  readonly defence?: number;
  readonly ranged?: number;
  readonly magic?: number;
}

export interface ScenarioRespawnPolicy {
  readonly mode: 'always' | 'never' | 'while-guardian-alive';
  readonly guardians?: Record<string, string>;
  readonly delayTicks?: number;
}

/** A scenario-defined gathering node (custom trees/rocks/spots beyond the world's own). */
export interface NodeSpawn {
  readonly at: TileCoord;
  readonly skill: SkillName;
  readonly requiredLevel: number;
  readonly xp: number;
  readonly yieldItem: ItemConfigId;
  /** Success chance pair in the gathering system's native /256 units at level 1 and 99. */
  readonly successLow: number;
  readonly successHigh: number;
  readonly depleteChance?: number; // 0..1
  readonly respawnTicks?: number;
  readonly tag?: string;
}

export interface ScenarioMeta {
  readonly id: string; // kebab-case slug
  readonly name: string;
  readonly description: string;
  readonly version: string; // semver of the doc, not the schema
  readonly schemaVersion: 0;
  readonly authors?: string[];
}

/**
 * Either a set of base-world 530 regions at their true world coordinates, a set of regions
 * translated onto one shared tile plane and stitched together (a "combined region"), or a
 * fully custom painted tilemap.
 */
export type MapRef =
  | { readonly kind: 'world-regions'; readonly regions: number[] }
  | { readonly kind: 'composite'; readonly composite: CompositeMap }
  | { readonly kind: 'custom'; readonly custom: CustomMap };

/**
 * One placement of a rev-530 map square into a composite map. The same `regionId` may be placed
 * any number of times at different offsets, so a composite can contain several copies of the same
 * source square.
 *
 * `offset` translates every tile, loc, NPC spawn, gathering node and climb loc of this copy by
 * (`dx`, `dz`) tiles. Both components MUST be multiples of 64 (REGION_SIZE) so the placed square
 * still lands on a region boundary and collision-zone allocation stays aligned. Omitting `offset`
 * places the copy at its true world position, which is what portal-linked composites use.
 *
 * `key` is the stable handle for THIS copy — links, spawns and admin placements that need to name
 * one particular copy use it. It must be unique within the composite. When omitted it defaults to
 * `<regionId>@<dx>,<dz>` (with `0,0` for an absent offset).
 */
export interface RegionPlacement {
  readonly regionId: number; // 0..65535
  readonly key?: string; // unique within the composite
  readonly offset?: { readonly dx: number; readonly dz: number }; // both multiples of 64
}

/**
 * A walkable tile bridge stitching two placed regions together. The inclusive rectangle spanned
 * by `from` and `to` is forced walkable at that level, overriding whatever the source regions
 * clipped there. Both corners must share `level`.
 */
export interface PathLink {
  readonly kind: 'path';
  readonly id: string; // unique within the composite
  readonly from: TileCoord;
  readonly to: TileCoord;
  readonly terrain?: TerrainKind; // visual only, default 'path'
}

/**
 * A teleport link between two tiles of a composite map. Entering `a` moves the entity to `b`
 * (and back, unless `bidirectional` is false). `loc` renders scenery at both endpoints.
 */
export interface PortalLink {
  readonly kind: 'portal';
  readonly id: string; // unique within the composite
  readonly a: TileCoord;
  readonly b: TileCoord;
  readonly bidirectional?: boolean; // default true
  readonly loc?: LocConfigId;
  readonly label?: string;
}

export type RegionLink = PathLink | PortalLink;

/**
 * Several rev-530 map squares placed on one shared tile plane and stitched together.
 * Two placements must not resolve to the same placed base tile, but the same `regionId` may
 * appear many times at different offsets. A composite with a single un-offset region is exactly
 * equivalent to the `world-regions` map of that region.
 */
export interface CompositeMap {
  readonly regions: RegionPlacement[];
  readonly links?: RegionLink[];
}

/**
 * A saved, reusable composite map. This is the shippable "combined region" artifact: it is stored
 * independently of any scenario so several scenarios and sandbox worlds can reference the same
 * assembled world.
 */
export interface CompositeDoc {
  readonly id: string; // kebab-case slug
  readonly name: string;
  readonly description?: string;
  readonly schemaVersion: 0;
  readonly composite: CompositeMap;
  /** Verified walkable default spawn in composite coordinates. */
  readonly spawn?: TileCoord;
}

/** Visual tile categories for custom maps. Purely cosmetic; collision comes from `walkable`. */
export type TerrainKind = 'grass' | 'dirt' | 'sand' | 'stone' | 'path' | 'water' | 'lava' | 'floor';

/**
 * One paintable tile style. `walkable` defaults to false for 'water'/'lava' terrain and
 * true otherwise. `height` is a visual elevation in quarter-tile units (collision unaffected).
 */
export interface TileStyle {
  readonly walkable?: boolean;
  readonly terrain?: TerrainKind; // default 'grass'
  readonly height?: number; // integer >= 0, default 0
}

/**
 * A painted tile grid. `rows` has exactly `height` strings of exactly `width` characters;
 * rows[0] is the NORTHERN edge (visual top), columns run west→east. Each character indexes
 * `palette`; characters not in the palette (including spaces) use `defaultTile`
 * (which itself defaults to walkable grass at height 0). The grid is anchored with its
 * south-west corner at `origin` (default { x: 8000, z: 8000, level: 0 } — empty space far
 * from the 530 world), so absolute x = origin.x + column, absolute z = origin.z + (height - 1 - row).
 */
export interface CustomMap {
  readonly width: number; // 1..192 tiles
  readonly height: number; // 1..192 tiles
  readonly origin?: TileCoord;
  readonly palette: Record<string, TileStyle>;
  readonly rows: string[];
  readonly defaultTile?: TileStyle;
}

export interface SpawnSet {
  readonly npcs?: NpcSpawn[];
  readonly locs?: LocSpawn[];
  readonly groundItems?: GroundItemSpawn[];
  readonly nodes?: NodeSpawn[];
}

export interface NpcSpawn {
  readonly npc: NpcConfigId;
  readonly at: TileCoord;
  readonly wanderRadius?: number;
  readonly respawnTicks?: number;
  /** Optional stable handle for triggers/dialogue to reference. */
  readonly tag?: string;
  readonly behavior?: NpcBehavior;
  readonly stats?: NpcStatOverrides;
  /** Key into ScenarioDoc.lootTables; dropped on this NPC's death. */
  readonly loot?: string;
}

export interface LocSpawn {
  readonly loc: LocConfigId;
  readonly at: TileCoord;
  readonly rotation?: 0 | 1 | 2 | 3;
  readonly tag?: string;
}

export interface GroundItemSpawn {
  readonly item: ItemConfigId;
  readonly amount: number;
  readonly at: TileCoord;
  readonly respawnTicks?: number;
}

/** A joinable slot for a human or agent player. */
export interface ActorSlot {
  readonly tag: string;
  readonly displayName?: string;
  readonly spawnAt: TileCoord;
  readonly stats?: Partial<Record<SkillName, number>>; // levels 1-99
  readonly inventory?: { item: ItemConfigId; amount: number }[];
  readonly equipment?: { item: ItemConfigId }[];
}

/** A stable scenario team. Each actor may belong to at most one team. */
export interface ScenarioTeam {
  readonly id: string;
  readonly actorTags: string[];
  readonly displayName?: string;
}

export interface DialogueTree {
  readonly id: string;
  readonly nodes: DialogueNode[];
  readonly entry: string; // node id
  /** World NPC config IDs that may start this dialogue. */
  readonly npc?: NpcConfigId | NpcConfigId[];
  readonly priority?: number;
}

export type DialogueCond =
  | { readonly flag: string }
  | { readonly not: DialogueCond }
  | { readonly all: DialogueCond[] }
  | { readonly any: DialogueCond[] }
  | {
      readonly quest: string;
      readonly stage: number | { readonly min?: number; readonly max?: number };
    }
  | { readonly skill: SkillName; readonly level: number }
  | { readonly item: ItemConfigId; readonly amount?: number }
  | { readonly questPoints: number };

export type DialogueNode =
  | { readonly id: string; readonly kind: 'npc'; readonly speakerTag: string; readonly text: string; readonly next?: string }
  | { readonly id: string; readonly kind: 'player'; readonly text: string; readonly next?: string }
  | { readonly id: string; readonly kind: 'choice'; readonly prompt?: string; readonly options: { text: string; next: string }[] }
  | { readonly id: string; readonly kind: 'action'; readonly emit: string; readonly next?: string }
  | { readonly id: string; readonly kind: 'if'; readonly cond: DialogueCond; readonly then: string; readonly else?: string }
  | { readonly id: string; readonly kind: 'set'; readonly flag: string; readonly value?: boolean | number | string; readonly next?: string }
  | { readonly id: string; readonly kind: 'quest'; readonly quest: string; readonly stage: number; readonly next?: string }
  | { readonly id: string; readonly kind: 'give'; readonly item: ItemConfigId; readonly amount: number; readonly next?: string }
  | { readonly id: string; readonly kind: 'take'; readonly item: ItemConfigId; readonly amount: number; readonly next?: string }
  | { readonly id: string; readonly kind: 'teleport'; readonly to: TileCoord; readonly next?: string }
  | { readonly id: string; readonly kind: 'xp'; readonly skill: SkillName; readonly amount: number; readonly next?: string }; // action fires a named trigger event

export interface Objective {
  readonly id: string;
  readonly description: string;
  readonly condition: Condition;
  /** Default actor scope inherited by condition leaves that omit their own actorTag. */
  readonly actorTag?: string;
  /** Optional team scope; mutually exclusive with actorTag. */
  readonly team?: string;
  /** 'win' | 'lose' | 'progress' — how completing this objective affects the game. */
  readonly outcome: 'win' | 'lose' | 'progress';
}

/** v0 condition algebra — deliberately small; grows with the engine. */
export type Condition =
  | {
      readonly kind: 'kill';
      readonly npc: NpcConfigId;
      readonly count: number;
      /** Optional actor whose attributed kills count toward this leaf. */
      readonly actorTag?: string;
      readonly team?: string;
    }
  | {
      readonly kind: 'obtain';
      readonly item: ItemConfigId;
      readonly amount: number;
      /** Optional actor whose item additions count toward this leaf. */
      readonly actorTag?: string;
      readonly team?: string;
    }
  | {
      readonly kind: 'reach';
      readonly area: { from: TileCoord; to: TileCoord };
      /** Optional actor whose movement can satisfy this leaf. */
      readonly actorTag?: string;
      readonly team?: string;
    }
  | {
      readonly kind: 'skill-level';
      readonly skill: SkillName;
      readonly level: number;
      /** Optional actor whose level changes can satisfy this leaf. */
      readonly actorTag?: string;
      readonly team?: string;
    }
  | {
      readonly kind: 'event';
      readonly name: string;
      /** Optional actor whose attributed scenario events can satisfy this leaf. */
      readonly actorTag?: string;
      readonly team?: string;
    } // emitted by dialogue/trigger actions
  | {
      /** Satisfied once the instance reaches `atLeast`. Evaluated per tick, not event-driven. */
      readonly kind: 'tick';
      readonly atLeast: number;
      readonly every?: number;
    }
  | { readonly kind: 'survivors'; readonly atMost: number; readonly actorTags?: string[]; readonly team?: string }
  | { readonly kind: 'eliminated'; readonly actorTag?: string; readonly team?: string }
  | {
      readonly kind: 'vote';
      readonly poll: string;
      readonly quorum: number;
      readonly actorTag?: string;
      readonly team?: string;
    }
  | { readonly kind: 'all'; readonly of: Condition[] }
  | { readonly kind: 'any'; readonly of: Condition[] };

export interface Trigger {
  readonly id: string;
  readonly on: Condition;
  readonly actions: TriggerAction[];
  readonly once?: boolean;
  readonly cooldownTicks?: number;
}

export type TriggerAction =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'spawn-npc'; readonly spawn: NpcSpawn }
  | { readonly kind: 'give-item'; readonly actorTag: string; readonly item: ItemConfigId; readonly amount: number }
  | { readonly kind: 'take-item'; readonly actorTag: string; readonly item: ItemConfigId; readonly amount: number }
  | { readonly kind: 'teleport'; readonly actorTag: string; readonly to: TileCoord }
  | { readonly kind: 'end'; readonly outcome: 'win' | 'lose' }
  | { readonly kind: 'start-dialogue'; readonly dialogue: string; readonly actorTag: string }
  | { readonly kind: 'play-cinematic'; readonly cinematic: string }
  | { readonly kind: 'emit'; readonly name: string }
  | {
      readonly kind: 'open-poll';
      readonly poll: string;
      readonly eligible?: { readonly actorTags?: string[]; readonly team?: string };
      readonly closesAfterTicks?: number;
    }
  | { readonly kind: 'close-poll'; readonly poll: string }
  | {
      readonly kind: 'broadcast';
      readonly text: string;
      readonly to?: { readonly actorTags?: string[]; readonly team?: string };
    }
  | {
      readonly kind: 'eliminate';
      readonly actorTag?: string;
      readonly team?: string;
      readonly pollWinner?: string;
    };

export interface Cinematic {
  readonly id: string;
  readonly shots: CinematicShot[];
}

export interface CinematicShot {
  readonly camera: { from: TileCoord; lookAt: TileCoord };
  readonly durationTicks: number;
  readonly caption?: string;
}
