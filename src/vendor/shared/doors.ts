import type { TileCoord } from './coords.ts';
import type { LocConfigId } from './ids.ts';
import { doorConfigFor } from './doorConfigs.ts';

/** One door leaf as placed in the world: which loc, where, how it is rotated, and its wall shape. */
export interface DoorLeaf {
  readonly loc: LocConfigId;
  readonly at: TileCoord;
  /** Quarter turns 0..3: 0 = west edge, 1 = north, 2 = east, 3 = south (rev-530 wall convention). */
  readonly rotation: number;
  /** Loc shape/type. Doors are 0..3 (wall shapes) or 9 (diagonal wall). */
  readonly shape: number;
}

/**
 * Current state of one map-placed door leaf. `original` is the identity from map data (never
 * changes); `current` is what is rendered and clipped right now. Restored doors have
 * `current` deep-equal to `original`.
 */
export interface DoorState {
  readonly original: DoorLeaf;
  readonly current: DoorLeaf;
  /** True when `current` is the open variant of the pair. */
  readonly open: boolean;
}

/** Stable identity of a map-placed door leaf: `${loc}:${x}:${z}:${level}`. */
export function doorKey(leaf: { readonly loc: number; readonly at: TileCoord }): string {
  return `${leaf.loc}:${leaf.at.x}:${leaf.at.z}:${leaf.at.level}`;
}

const DOOR_NAME_TOKENS = ['door', 'gate', 'fence', 'wall', 'exit', 'entrance'] as const;
const NOT_DOOR_NAME_TOKENS = ['trapdoor', 'trap door', 'drawers', 'wardrobe', 'cupboard'] as const;
const DOOR_SHAPES: ReadonlySet<number> = new Set([0, 1, 2, 3, 9]);

/**
 * Whether a loc definition is an interactable door/gate leaf. Mirrors the rev-530 rule: the
 * definition offers an `open`/`close` option, its name contains a door-like token, it is a
 * wall-shaped loc, and it has a known open/closed counterpart in `DOOR_PAIRS`. Locs that fail the
 * last test stay baked into region terrain and are not interactive ("the door is stuck").
 *
 * Provenance: 2009scape content/global/handlers/scenery/DoorManagingPlugin.java:28-84 (option
 * names and name filter). No source code copied.
 */
export function isDoorLoc(
  locId: number,
  name: string,
  options: readonly (string | null)[],
  shape: number
): boolean {
  if (!DOOR_SHAPES.has(shape)) return false;
  if (doorConfigFor(locId) === undefined) return false;
  const lowered = name.toLowerCase();
  if (NOT_DOOR_NAME_TOKENS.some((token) => lowered.includes(token))) return false;
  if (!DOOR_NAME_TOKENS.some((token) => lowered.includes(token))) return false;
  const opts = options.filter((option): option is string => option !== null)
    .map((option) => option.toLowerCase());
  return opts.includes('open') || opts.includes('close');
}
