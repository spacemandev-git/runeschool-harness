import { eventActor, type SimEvent, type TileCoord } from '../shared/index.ts';
import { distanceBetween } from './fold.ts';

const ALWAYS_VISIBLE: ReadonlySet<string> = new Set([
  'instance-ended',
  'scenario-event',
  'scenario-message',
  'trigger-fired',
  'cinematic-started',
  'objective-complete',
  'poll-opened',
  'vote-tally',
  'poll-closed',
  'team-won',
  'team-lost',
  'scenario-won',
  'scenario-lost',
  'error'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTile(value: unknown): TileCoord | undefined {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.z !== 'number'
    || typeof value.level !== 'number') return undefined;
  return { x: value.x, z: value.z, level: value.level };
}

function containsNearbyTile(value: unknown, at: TileCoord, radius: number, depth: number): boolean {
  const found = asTile(value);
  if (found !== undefined && distanceBetween(at, found) <= radius) return true;
  if (depth >= 3 || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => containsNearbyTile(child, at, radius, depth + 1));
}

function participantPair(value: unknown): readonly [number, number] | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.a) || !Number.isSafeInteger(value.b)) return undefined;
  return [value.a as number, value.b as number];
}

export function isVisibleTo(
  event: SimEvent,
  self: { readonly entity: number; readonly tag: string; readonly at: TileCoord },
  radius: number,
  known: ReadonlySet<number>
): boolean {
  if (event.type === 'tick') return false;
  if (event.type === 'chat' && isRecord(event.data)) {
    if (event.data.channel === 'pm') {
      return event.data.entity === self.entity || event.data.to === self.tag;
    }
    // Clan membership is enforced by the actor-authenticated server stream.
    if (event.data.channel === 'clan') return true;
    if (event.data.channel === 'public') {
      return event.data.entity === self.entity
        || (typeof event.data.entity === 'number' && known.has(event.data.entity));
    }
    return false;
  }
  const participants = participantPair(event.data);
  if (participants !== undefined) return participants.includes(self.entity);
  if (ALWAYS_VISIBLE.has(event.type)) return true;
  const actor = eventActor(event);
  if (actor === self.entity || (actor !== undefined && known.has(actor))) return true;
  const data = event.data as unknown;
  if (isRecord(data) && data.actorTag === self.tag) return true;
  return containsNearbyTile(data, self.at, radius, 0);
}
