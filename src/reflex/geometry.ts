import type { TileCoord } from '#protocol';

export function chebyshev(a: TileCoord, b: TileCoord): number {
  if (a.level !== b.level) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

export function adjacent(a: TileCoord, b: TileCoord): boolean {
  return chebyshev(a, b) <= 1;
}

export function towards(from: TileCoord, to: TileCoord, distance = 1): TileCoord {
  if (from.level !== to.level) return { ...to };
  const steps = Math.max(0, Math.floor(distance));
  return {
    x: from.x + Math.sign(to.x - from.x) * Math.min(steps, Math.abs(to.x - from.x)),
    z: from.z + Math.sign(to.z - from.z) * Math.min(steps, Math.abs(to.z - from.z)),
    level: from.level
  };
}

export function stepAwayFrom(from: TileCoord, threat: TileCoord, distance = 8): TileCoord {
  const steps = Math.max(0, Math.floor(distance));
  return {
    x: Math.max(0, from.x + Math.sign(from.x - threat.x) * steps),
    z: Math.max(0, from.z + Math.sign(from.z - threat.z) * steps),
    level: from.level
  };
}
