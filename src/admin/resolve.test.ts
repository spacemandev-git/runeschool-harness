import { describe, expect, test } from 'bun:test';
import type { RuntimeView } from '../core/runtime.ts';
import { chebyshev, resolveAgent, resolveName, spiralTiles } from './resolve.ts';

const names = {
  items: { '10': 'Bronze sword', '11': 'Bronze sword (p)', '12': 'Swordfish' },
  npcs: { '1': 'Goblin', '2': 'Goblin guard', '3': 'Hobgoblin', '4': 'Goblin' },
  locs: { '20': 'Tree' }
};

function view(): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0,
    agents: () => [
      { id: 'hero', displayName: 'Hero', tag: 'h', entity: 7, state: 'idle', model: 'm', activity: 'idle', turns: 0 },
      { id: 'scout', displayName: 'Scout', tag: 'sc', entity: 9, state: 'idle', model: 'm', activity: 'idle', turns: 0 }
    ],
    teams: () => [], agentSnapshot: () => undefined, agentReflexes: () => undefined,
    agentTranscript: () => [], directorTranscript: () => [], adminTranscript: () => [],
    coordinatorTranscript: () => [], usage: () => [], config: () => ({})
  };
}

describe('admin resolution', () => {
  test('ranks exact before prefix before substring and resolves numeric ids', () => {
    expect(resolveName(names, 'npc', 'goblin', 10)).toEqual([
      { id: 1, name: 'Goblin' }, { id: 4, name: 'Goblin' },
      { id: 2, name: 'Goblin guard' }, { id: 3, name: 'Hobgoblin' }
    ]);
    expect(resolveName(names, 'item', '11', 10)).toEqual([{ id: 11, name: 'Bronze sword (p)' }]);
    expect(resolveName(names, 'loc', '999', 10)).toEqual([]);
  });

  test('looks up agents by harness id and actor tag', () => {
    expect(resolveAgent(view(), 'hero')?.entity).toBe(7);
    expect(resolveAgent(view(), 'sc')?.id).toBe('scout');
    expect(resolveAgent(view(), 'missing')).toBeUndefined();
  });

  test('builds radius-two rings clockwise from north-east with optional centre', () => {
    const anchor = { x: 10, z: 20, level: 2 };
    const ringOne = [
      { x: 11, z: 21, level: 2 }, { x: 11, z: 20, level: 2 }, { x: 11, z: 19, level: 2 },
      { x: 10, z: 19, level: 2 }, { x: 9, z: 19, level: 2 }, { x: 9, z: 20, level: 2 },
      { x: 9, z: 21, level: 2 }, { x: 10, z: 21, level: 2 }
    ];
    const ringTwo = spiralTiles(anchor, 2, false).slice(8);
    expect(spiralTiles(anchor, 2, false).slice(0, 8)).toEqual(ringOne);
    expect(ringTwo).toHaveLength(16);
    expect(ringTwo[0]).toEqual({ x: 12, z: 22, level: 2 });
    expect(ringTwo.at(-1)).toEqual({ x: 11, z: 22, level: 2 });
    expect(spiralTiles(anchor, 2, true)).toEqual([anchor, ...ringOne, ...ringTwo]);
    expect(chebyshev(anchor, { x: 12, z: 18, level: 2 })).toBe(2);
    expect(chebyshev(anchor, { x: 10, z: 20, level: 1 })).toBe(Infinity);
  });
});
