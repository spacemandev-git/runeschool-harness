import type { JsonValue } from '#protocol';
import type { ActorLink, DefsReader, WorldView } from '../core/index.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function entries(value: JsonValue, key: string): readonly unknown[] {
  const root = record(value);
  return root !== undefined && Array.isArray(root[key]) ? root[key] : [];
}

function compact(value: unknown, distance: number): JsonValue {
  const row = record(value);
  if (row === undefined) return { value: String(value), distance };
  const allowed = ['id', 'entity', 'kind', 'name', 'npc', 'loc', 'item', 'amount', 'at',
    'skill', 'requiredLevel', 'depleted', 'actorTag'];
  return { ...Object.fromEntries(allowed.flatMap((key) => row[key] === undefined ? [] : [[key, row[key]]])), distance } as JsonValue;
}

export function createWorldReads(link: ActorLink, _defs: DefsReader, view: WorldView): {
  scan(query: string): Promise<JsonValue>;
} {
  return {
    async scan(query): Promise<JsonValue> {
      const normalized = query.trim().toLowerCase();
      const [entitiesValue, nodesValue, stationsValue, groundValue] = await Promise.all([
        link.get('/entities'), link.get('/nodes'), link.get('/stations'), link.get('/ground-items')
      ]);
      const select = (values: readonly unknown[]): JsonValue[] => values
        .filter((value) => normalized.length === 0 || JSON.stringify(value).toLowerCase().includes(normalized))
        .slice(0, 50)
        .map((value) => {
          const at = record(record(value)?.at);
          const distance = at !== undefined && typeof at.x === 'number' && typeof at.z === 'number'
            && typeof at.level === 'number'
            ? view.distanceTo({ x: at.x, z: at.z, level: at.level }) : Number.POSITIVE_INFINITY;
          return compact(value, Number.isFinite(distance) ? distance : -1);
        });
      return {
        query,
        entities: select(entries(entitiesValue, 'entities')),
        nodes: select(entries(nodesValue, 'nodes')),
        stations: select(entries(stationsValue, 'stations')),
        groundItems: select(entries(groundValue, 'items'))
      };
    }
  };
}
