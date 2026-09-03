import { describe, expect, test } from 'bun:test';
import { eventOf, hitEvent, movedEvent } from './testing.ts';
import { isVisibleTo } from './visibility.ts';

const self = { entity: 1, tag: 'hero', at: { x: 100, z: 100, level: 0 } } as const;

describe('per-actor event visibility', () => {
  test('keeps self, actor-tagged, known, nearby, and global events', () => {
    expect(isVisibleTo(movedEvent(1), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('objective-complete', {
      objective: 'win', outcome: 'win', actorTag: 'hero'
    }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(hitEvent(2, 9, 1, 4), self, 5, new Set([2]))).toBe(true);
    expect(isVisibleTo(movedEvent(9, { x: 90, z: 90, level: 0 }, { x: 104, z: 103, level: 0 }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('scenario-message', { text: 'global' }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('poll-opened', { poll: 'council', eligible: [1, 2] }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('vote-tally', { poll: 'council', counts: [], abstentions: 0, eligible: 2 }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('poll-closed', { poll: 'council', winner: 2, reason: 'quorum' }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('team-won', { team: 'red', objective: 'red-wins' }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('team-lost', { team: 'blue', objective: 'red-wins' }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('vote-cast', { entity: 1, poll: 'council', target: 2 }), self, 5, new Set())).toBe(true);
    expect(isVisibleTo(eventOf('vote-cast', { entity: 2, poll: 'council', target: 1 }), self, 5, new Set([2]))).toBe(true);
  });

  test('drops ticks, distant coordinates, other levels, and unattributed events', () => {
    expect(isVisibleTo(eventOf('tick', {}), self, 5, new Set([1]))).toBe(false);
    expect(isVisibleTo(movedEvent(9, { x: 90, z: 90, level: 0 }, { x: 106, z: 100, level: 0 }), self, 5, new Set())).toBe(false);
    expect(isVisibleTo(movedEvent(9, { x: 100, z: 100, level: 1 }, { x: 100, z: 100, level: 1 }), self, 5, new Set())).toBe(false);
    expect(isVisibleTo(eventOf('node-depleted', { node: 'far-tree' }), self, 5, new Set())).toBe(false);
    expect(isVisibleTo(eventOf('vote-cast', { entity: 9, poll: 'council', target: 1 }), self, 5, new Set())).toBe(false);
  });
});
