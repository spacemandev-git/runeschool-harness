import type { TileCoord } from '#protocol';
import type { AgentSummary, RuntimeView } from '../core/runtime.ts';
import type { DefsReader } from '../core/transport.ts';

export type NameKind = 'npc' | 'item' | 'loc';
export interface NameMatch { readonly id: number; readonly name: string; }

type Names = Awaited<ReturnType<DefsReader['names']>>;

function dictionary(names: Names, kind: NameKind): Readonly<Record<string, string>> {
  if (kind === 'npc') return names.npcs;
  if (kind === 'item') return names.items;
  return names.locs ?? {};
}

/** Resolve config names with exact matches before prefixes before substrings. */
export function resolveName(names: Names, kind: NameKind, query: string, limit = 10): readonly NameMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0 || !Number.isInteger(limit) || limit < 1) return [];
  const entries = Object.entries(dictionary(names, kind)).flatMap(([rawId, name]) => {
    const id = Number(rawId);
    return Number.isSafeInteger(id) ? [{ id, name }] : [];
  });
  if (/^\d+$/.test(needle)) {
    const id = Number(needle);
    const found = entries.find((entry) => entry.id === id);
    return found === undefined ? [] : [found];
  }
  return entries
    .flatMap((entry) => {
      const candidate = entry.name.toLocaleLowerCase();
      const rank = candidate === needle ? 0 : candidate.startsWith(needle) ? 1 : candidate.includes(needle) ? 2 : -1;
      return rank < 0 ? [] : [{ ...entry, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.id - b.id)
    .slice(0, limit)
    .map(({ id, name }) => ({ id, name }));
}

/** Resolve an agent by harness id or actor tag. */
export function resolveAgent(view: RuntimeView, ref: string): AgentSummary | undefined {
  const query = ref.trim();
  return view.agents().find((agent) => agent.id === query)
    ?? view.agents().find((agent) => agent.tag === query);
}

/** Square rings, starting north-east and proceeding clockwise; centre is optional. */
export function spiralTiles(anchor: TileCoord, radius: number, includeCentre: boolean): readonly TileCoord[] {
  const tiles: TileCoord[] = includeCentre ? [{ ...anchor }] : [];
  const maximum = Math.max(0, Math.floor(radius));
  for (let ring = 1; ring <= maximum; ring++) {
    for (let dz = ring; dz >= -ring; dz--) tiles.push({ x: anchor.x + ring, z: anchor.z + dz, level: anchor.level });
    for (let dx = ring - 1; dx >= -ring; dx--) tiles.push({ x: anchor.x + dx, z: anchor.z - ring, level: anchor.level });
    for (let dz = -ring + 1; dz <= ring; dz++) tiles.push({ x: anchor.x - ring, z: anchor.z + dz, level: anchor.level });
    for (let dx = -ring + 1; dx < ring; dx++) tiles.push({ x: anchor.x + dx, z: anchor.z + ring, level: anchor.level });
  }
  return tiles;
}

export function chebyshev(a: TileCoord, b: TileCoord): number {
  return a.level === b.level ? Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) : Infinity;
}
