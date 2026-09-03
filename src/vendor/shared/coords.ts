/**
 * World coordinates. Absolute tile coordinates in the rev-530 world grid:
 * x/z in [0, 16384), level in [0, 4). One tile = 128 fine ("sub-tile") units.
 */
export interface TileCoord {
  readonly x: number;
  readonly z: number;
  readonly level: number;
}

/** Packed tile coord: (level << 28) | (x << 14) | z. Fits in a 31-bit int. */
export type PackedCoord = number;

export function packCoord(x: number, z: number, level: number): PackedCoord {
  return ((level & 0x3) << 28) | ((x & 0x3fff) << 14) | (z & 0x3fff);
}

/** A 64x64-tile map square (a "region" in 530 terms). regionId = (rx << 8) | rz. */
export type RegionId = number;

export function regionIdOf(x: number, z: number): RegionId {
  return ((x >>> 6) << 8) | (z >>> 6);
}

/** An 8x8-tile zone, the interest-management granule. */
export function zoneKey(x: number, z: number, level: number): number {
  return ((level & 0x3) << 22) | ((x >>> 3) << 11) | (z >>> 3);
}

export const TICK_MILLIS = 600;
/** Simulation tick counter within an instance. Starts at 0. */
export type Tick = number;
