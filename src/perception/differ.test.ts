import { describe, expect, test } from 'bun:test';
import { diffSnapshots } from './differ.ts';
import { diedEvent, eventOf, hitEvent, makeSnapshot } from './testing.ts';

describe('diffSnapshots', () => {
  test('fills every structured change from snapshots and events', () => {
    const base = makeSnapshot();
    const goblin = {
      id: 2, kind: 'npc' as const, name: 'Goblin', npc: 100,
      at: { x: 101, z: 100, level: 0 }, distance: 1,
      hp: { current: 5, max: 5 }, lastSeenTick: 10
    };
    const before = makeSnapshot({
      self: { ...base.self, hp: { current: 10, max: 10 } },
      inventory: [
        { slot: 0, item: 526, name: 'Bones', amount: 1 },
        { slot: 1, item: 526, name: 'Bones', amount: 2 },
        { slot: 2, item: 315, name: 'Shrimps', amount: 1 }
      ],
      nearby: [goblin],
      objectives: [{
        id: 'goal', description: 'Win', outcome: 'win', complete: false,
        progress: [{ path: 'kills', kind: 'count', current: 0, target: 1, satisfied: false }]
      }],
      lastEventSeq: 4
    });
    const after = makeSnapshot({
      tick: 14,
      self: { ...base.self, hp: { current: 7, max: 10 }, at: { x: 102, z: 100, level: 0 } },
      inventory: [{ slot: 0, item: 526, name: 'Bones', amount: 5 }],
      inventoryFree: 27,
      nearby: [{
        id: 3, kind: 'player', name: 'Ally', at: { x: 102, z: 101, level: 0 },
        distance: 1, lastSeenTick: 14
      }],
      groundItems: [{
        id: 88, item: 526, name: 'Bones', amount: 1,
        at: { x: 100, z: 100, level: 0 }, distance: 2
      }],
      dialogue: { active: true, speaker: 'Guide', text: 'Choose', options: ['A', 'B'] },
      objectives: [{
        id: 'goal', description: 'Win', outcome: 'win', complete: true,
        progress: [{ path: 'kills', kind: 'count', current: 1, target: 1, satisfied: true }]
      }],
      lastEventSeq: 12
    });
    const events = [
      hitEvent(2, 1, 3, 7, 5, 11),
      hitEvent(1, 2, 4, 1, 6, 11),
      eventOf('xp-gained', { entity: 1, skill: 'attack', amount: 5, totalXp: 5 }, { seq: 7 }),
      eventOf('xp-gained', { entity: 1, skill: 'attack', amount: 7, totalXp: 12 }, { seq: 8 }),
      eventOf('level-up', { entity: 1, skill: 'attack', level: 2 }, { seq: 9 }),
      diedEvent(2, 1, 10, 13),
      eventOf('scenario-message', { text: 'The gate opens.' }, { seq: 11 }),
      eventOf('moved', {
        entity: 1, from: base.self.at, to: after.self.at, running: false
      }, { seq: 12, tick: 14 })
    ];
    const delta = diffSnapshots(before, after, events);
    expect(delta.hp).toEqual({ before: { current: 10, max: 10 }, after: { current: 7, max: 10 } });
    expect(delta.moved?.to).toEqual({ x: 102, z: 100, level: 0 });
    expect(delta.itemsGained).toEqual([{ item: 526, amount: 2, name: 'Bones' }]);
    expect(delta.itemsLost).toEqual([{ item: 315, amount: 1, name: 'Shrimps' }]);
    expect(delta.entered.map((entity) => entity.id)).toEqual([3]);
    expect(delta.left).toEqual([{ id: 2, name: 'Goblin' }]);
    expect(delta.damageTaken).toBe(3);
    expect(delta.damageDealt).toBe(4);
    expect(delta.xpGained).toEqual([{ skill: 'attack', amount: 12 }]);
    expect(delta.levelUps).toEqual([{ skill: 'attack', level: 2 }]);
    expect(delta.deaths).toEqual([{ entity: 2, name: 'Goblin', killer: 1, isSelf: false }]);
    expect(delta.dialogue).toEqual(after.dialogue);
    expect(delta.objectivesChanged).toEqual(after.objectives);
    expect(delta.groundItemsAppeared).toEqual(after.groundItems);
    expect(delta.messages).toEqual(['The gate opens.']);
    expect(delta.rejections).toEqual([]);
  });
});

