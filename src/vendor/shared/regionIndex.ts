import type { RegionId, TileCoord } from './coords.ts';
import type { SkillName } from './ids.ts';

/**
 * The region catalogue: a precomputed, cache-validated description of every rev-530 map square
 * that a sandbox instance can actually be created from.
 *
 * This exists because the cache is not self-describing on either axis the picker needs:
 *
 * - Availability. Of 1229 map squares with a mapscape group, 926 can actually host an instance:
 *   32 fail landscape decode for want of a working XTEA key, 227 decode to zero locs (open water
 *   and filler), 4 throw while building collision, and 40 contain no walkable tile. Offering a raw
 *   enumeration would hand callers hundreds of region ids that throw at instance-creation time.
 * - Identity. Nothing in the cache or in 2009scape maps a region id to a place name, so names are
 *   derived (see `RegionNameSource`) rather than read.
 *
 * The artifact is generated offline by `tools/regionindex` and committed, because a full
 * sweep-decode of the cache takes ~9s -- too slow to do at server start.
 *
 * Keep these types JSON-serializable (no functions, no classes).
 */

export const REGION_INDEX_VERSION = 1;

/** How an entry's `name` was arrived at. Callers surface this so a guess never reads as a fact. */
export type RegionNameSource =
  /** A hand-written entry in the generator's override table, verified against region contents. */
  | 'curated'
  /** Extracted from the titles of shops whose NPCs spawn in this region. */
  | 'shop'
  /** No name could be derived; `name` is the generated `Region <id> (<rx>,<rz>)` label. */
  | 'fallback';

/**
 * Why a region cannot host an instance. Absent on usable entries.
 * `xtea` -- landscape group is encrypted and no working key exists (32 squares).
 * `empty` -- decodes, but has no locs at all (open ocean, filler squares; 227 squares).
 * `collision` -- decodes, but building its collision map throws because a placed loc references a
 *   config id outside the rev-530 definition range (4 squares: 7511, 10075, 10658, 12102).
 * `unwalkable` -- decodes and has locs, but the square contains no walkable tile at all
 *   (40 squares -- solid rock, roofed-over interiors, and the like).
 */
export type RegionUnusableReason = 'xtea' | 'empty' | 'collision' | 'unwalkable';

export interface RegionIndexEntry {
  readonly regionId: RegionId;
  /** regionId >> 8 and regionId & 0xff -- the map-square coordinates, for display and search. */
  readonly regionX: number;
  readonly regionZ: number;
  /** South-west tile of the square: regionX << 6, regionZ << 6. */
  readonly baseX: number;
  readonly baseZ: number;
  /** Display name. Never empty -- falls back to `Region <id> (<rx>,<rz>)`. */
  readonly name: string;
  readonly nameSource: RegionNameSource;
  /**
   * True only if the region decoded, has locs, and has a verified walkable spawn tile.
   * A caller may pass an entry with `usable: false` to the server, and the server will reject it;
   * the picker's job is to not offer it in the first place.
   */
  readonly usable: boolean;
  /** Present iff `usable` is false. */
  readonly unusable?: RegionUnusableReason;
  /**
   * A tile verified walkable at generation time against the same `WORLD_WALK_BLOCKERS` mask the
   * server uses. Present iff `usable` is true. Preferred over guessing the square's centre.
   */
  readonly spawn?: TileCoord;
  /** Walkable tile count on level 0, out of 4096. A crude "is there anything here" signal. */
  readonly walkableTiles: number;
  /** Number of 2009scape NPC spawn points inside the square. */
  readonly npcCount: number;
  /** Gathering node counts by skill, e.g. `{ woodcutting: 14, mining: 3 }`. Omits zero counts. */
  readonly nodeCounts: Partial<Record<SkillName, number>>;
  /**
   * Lowercase free-text search keys derived from the region's contents: distinctive loc names
   * (`bank booth`, `furnace`, `anvil`, `altar`, `range`), frequent NPC names (`goblin`, `cow`),
   * and the name tokens. This is what the picker's type-ahead matches against, and it is the
   * reason search is useful even for the ~600 regions with no derivable place name.
   */
  readonly tags: readonly string[];
}

export interface RegionIndexFile {
  readonly version: typeof REGION_INDEX_VERSION;
  /** Cache revision the sweep ran against, for staleness checks. */
  readonly revision: number;
  readonly counts: {
    readonly total: number;
    readonly usable: number;
    readonly named: number;
  };
  /** Ascending by `regionId`. */
  readonly regions: readonly RegionIndexEntry[];
}

/** Response body of `GET /world/regions`. */
export interface RegionListResponse {
  readonly version: typeof REGION_INDEX_VERSION;
  readonly revision: number;
  readonly counts: RegionIndexFile['counts'];
  /**
   * Ascending by `regionId`. Contains only `usable` entries unless the request passes
   * `?include=all`, so the default response is safe to render directly into a picker.
   */
  readonly regions: readonly RegionIndexEntry[];
}

/** A `filterRegions` match, carrying why it matched so callers can group or explain results. */
export interface RegionMatch {
  readonly entry: RegionIndexEntry;
  /** Lower sorts first. 0 exact id, 1 name prefix, 2 name substring, 3 tag prefix, 4 tag substring. */
  readonly rank: number;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function rankEntry(entry: RegionIndexEntry, query: string): number | undefined {
  if (query === '') return 5;
  if (String(entry.regionId) === query) return 0;
  const name = entry.name.toLowerCase();
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  let best: number | undefined;
  for (const tag of entry.tags) {
    if (tag.startsWith(query)) return 3;
    if (tag.includes(query)) best = 4;
  }
  return best;
}

/**
 * Rank regions for a type-ahead picker. Deterministic and pure -- the hub picker and the MCP
 * `list_regions` tool both call this so that the same query returns the same order in both.
 *
 * An empty query lists everything, named regions first. Ties break by NPC population (busier
 * regions are the more useful sandboxes) and then by ascending id.
 */
export function filterRegions(
  entries: readonly RegionIndexEntry[],
  query: string,
  limit?: number
): readonly RegionMatch[] {
  const normalized = normalizeQuery(query);
  const matches: RegionMatch[] = [];
  for (const entry of entries) {
    const rank = rankEntry(entry, normalized);
    if (rank !== undefined) matches.push({ entry, rank });
  }
  matches.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    const namedLeft = left.entry.nameSource === 'fallback' ? 1 : 0;
    const namedRight = right.entry.nameSource === 'fallback' ? 1 : 0;
    if (namedLeft !== namedRight) return namedLeft - namedRight;
    if (left.entry.npcCount !== right.entry.npcCount) return right.entry.npcCount - left.entry.npcCount;
    return left.entry.regionId - right.entry.regionId;
  });
  return limit === undefined ? matches : matches.slice(0, limit);
}
