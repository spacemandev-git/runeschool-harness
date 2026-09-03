import type { JsonValue } from '#protocol';
import type { DefsReader } from '../core/index.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'));
}

async function getJson(url: string): Promise<JsonValue> {
  const response = await fetch(url);
  const text = await response.text();
  let body: JsonValue = text;
  try { body = JSON.parse(text) as JsonValue; } catch { /* retain raw text for the error */ }
  if (!response.ok) throw new Error(`Defs HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

export function serverBaseUrlOf(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.pathname = url.pathname.replace(/\/instances\/[^/]+\/?$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function createDefsReader(serverBaseUrl: string): DefsReader {
  const base = serverBaseUrl.replace(/\/$/, '');
  let namesPromise: ReturnType<DefsReader['names']> | undefined;
  const regions = new Map<number, Promise<JsonValue>>();
  return {
    names(): ReturnType<DefsReader['names']> {
      namesPromise ??= getJson(`${base}/defs/names`).then((value) => {
        const record = isRecord(value) ? value : {};
        const locs = stringMap(record.locs);
        return {
          items: stringMap(record.items),
          npcs: stringMap(record.npcs),
          ...(Object.keys(locs).length === 0 ? {} : { locs })
        };
      });
      return namesPromise;
    },
    region(regionId: number): Promise<JsonValue> {
      let pending = regions.get(regionId);
      if (pending === undefined) {
        pending = getJson(`${base}/world/regions/${encodeURIComponent(String(regionId))}`);
        regions.set(regionId, pending);
      }
      return pending;
    }
  };
}

