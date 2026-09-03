import type { TileCoord } from './coords.ts';

export type ZoneTag = 'multi' | 'wilderness' | 'safe' | 'pvp' | 'no-teleport';

export interface ZoneDef {
  readonly id: string;
  readonly from: TileCoord;
  readonly to: TileCoord;
  /** Applies on every plane when absent. */
  readonly level?: number;
  readonly tags: readonly ZoneTag[];
}

export interface ZoneQuery {
  zonesAt(at: TileCoord): readonly ZoneDef[];
  has(at: TileCoord, tag: ZoneTag): boolean;
  wildernessLevel(at: TileCoord): number;
}

/** Build a deterministic, scan-based query over inclusive zone rectangles. */
export function createZoneQuery(zones: readonly ZoneDef[]): ZoneQuery {
  const ordered = zones.slice().sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  const zonesAt = (at: TileCoord): readonly ZoneDef[] => ordered.filter((zone) => (
    (zone.level === undefined || zone.level === at.level)
    && at.x >= Math.min(zone.from.x, zone.to.x)
    && at.x <= Math.max(zone.from.x, zone.to.x)
    && at.z >= Math.min(zone.from.z, zone.to.z)
    && at.z <= Math.max(zone.from.z, zone.to.z)
  ));

  const query: ZoneQuery = {
    zonesAt,
    has: (at: TileCoord, tag: ZoneTag) => zonesAt(at).some((zone) => zone.tags.includes(tag)),
    wildernessLevel: (at: TileCoord) => {
      if (!zonesAt(at).some((zone) => zone.tags.includes('wilderness'))) return 0;
      return Math.floor((at.z - (at.z > 6_400 ? 9_920 : 3_520)) / 8) + 1;
    }
  };
  return Object.freeze(query);
}
