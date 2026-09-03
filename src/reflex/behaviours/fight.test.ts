import { describe, expect, test } from 'bun:test';
import { FIGHT } from './fight.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

const npc = (id: number, x = 1) => ({
  id,
  kind: 'npc' as const,
  name: 'Goblin',
  at: { x, z: 0, level: 0 },
  distance: x,
  lastSeenTick: 0,
  hp: { current: 3, max: 3 }
});
const player = (id: number, name = 'Blue Vanguard', x = 1) => ({
  id,
  kind: 'player' as const,
  name,
  at: { x, z: 0, level: 0 },
  distance: x,
  lastSeenTick: 0,
  hp: { current: 70, max: 70 }
});

describe('fight', () => {
  test('counts kills, retargets, and fails on self death', async () => {
    const context = new FakeContext(makeSnapshot({
      self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc(2), npc(3)]
    }));
    const behaviour = FIGHT.create({ name: 'goblin', kills: 2 });
    await behaviour.start(context);
    context.setSnapshot(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc(3)] }));
    context.inject(makeEvent('died', { entity: 2, killer: 1 }));
    expect((await behaviour.step(context)).state).toBe('running');
    context.clearEvents();
    context.setSnapshot(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [] }));
    context.inject(makeEvent('died', { entity: 3, killer: 1 }));
    expect(await behaviour.step(context)).toMatchObject({ state: 'done' });

    const dying = FIGHT.create({ name: 'goblin' });
    const dyingContext = new FakeContext(makeSnapshot({ nearby: [npc(2)] }));
    await dying.start(dyingContext);
    dyingContext.inject(makeEvent('died', { entity: 1 }));
    expect(await dying.step(dyingContext)).toMatchObject({ state: 'failed', retryable: false });
  });

  test('casts within ten Chebyshev tiles and walks when outside spell reach', async () => {
    expect(FIGHT.validate({ spell: 'wind-strike' }).ok).toBeTrue();
    expect(FIGHT.validate({ spell: 'varrock-teleport' }).ok).toBeFalse();

    const inRange = new FakeContext(makeSnapshot({
      self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc(2, 10)]
    }));
    await FIGHT.create({ target: 2, spell: 'wind-strike' }).start(inRange);
    expect(inRange.intents[0]).toMatchObject({
      type: 'cast', data: { target: 2, spell: 'wind-strike' }
    });

    const outOfRange = new FakeContext(makeSnapshot({
      self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc(2, 11)]
    }));
    await FIGHT.create({ target: 2, radius: 12, spell: 'wind-strike' }).start(outOfRange);
    expect(outOfRange.intents[0]).toMatchObject({
      type: 'walk', data: { dest: { x: 11, z: 0, level: 0 } }
    });
  });

  test('targets players only when targetKind opts in', async () => {
    const mixed = [
      { ...player(2), distance: 0.5 },
      npc(3)
    ];
    const npcContext = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: mixed }));
    await FIGHT.create({}).start(npcContext);
    expect(npcContext.intents[0]).toMatchObject({ type: 'attack', data: { target: 3 } });

    const playerContext = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: mixed }));
    await FIGHT.create({ targetKind: 'player' }).start(playerContext);
    expect(playerContext.intents[0]).toMatchObject({ type: 'attack', data: { target: 2 } });
  });

  test('targetKind any picks the nearest living NPC or player', async () => {
    const context = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [
      { ...npc(2), distance: 2 },
      { ...player(3), at: { x: 0, z: 1, level: 0 }, distance: 1 }
    ] }));
    await FIGHT.create({ targetKind: 'any' }).start(context);
    expect(context.intents[0]).toMatchObject({ type: 'attack', data: { target: 3 } });
  });

  test('explicit player target works with targetKind player', async () => {
    const context = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc(2), player(3)] }));
    await FIGHT.create({ target: 3, targetKind: 'player' }).start(context);
    expect(context.intents[0]).toMatchObject({ type: 'attack', data: { target: 3 } });
  });

  test('enemy team name filter matches Blue Vanguard but not Red Support', async () => {
    const context = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [
      { ...player(2, 'Red Support'), distance: 0.5 },
      { ...player(3, 'Blue Vanguard'), at: { x: 0, z: 1, level: 0 }, distance: 1 }
    ] }));
    await FIGHT.create({ name: 'blue', targetKind: 'player' }).start(context);
    expect(context.intents[0]).toMatchObject({ type: 'attack', data: { target: 3 } });
    expect(FIGHT.validate({ targetKind: 'monster' }).errors)
      .toContainEqual({ path: 'targetKind', message: 'unknown target kind' });
  });
});
