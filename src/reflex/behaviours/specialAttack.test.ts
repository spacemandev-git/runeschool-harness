import { describe, expect, test } from 'bun:test';
import { SPECIAL_ATTACK } from './specialAttack.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('special-attack', () => {
  test('toggles special, attacks, and completes on the matching special event', async () => {
    const ctx = new FakeContext(makeSnapshot({ nearby: [{
      id: 2, kind: 'npc', name: 'Goblin', at: { x: 3201, z: 3200, level: 0 },
      distance: 1, hp: { current: 5, max: 5 }, lastSeenTick: 0
    }] }));
    const behaviour = SPECIAL_ATTACK.create({ target: 2 });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'running' });
    expect(ctx.intents.map((intent) => intent.type)).toEqual(['special', 'attack']);
    ctx.inject(makeEvent('special-attack', {
      attacker: 1, target: 2, weapon: 4151, special: 'energy-drain', energyCost: 50
    }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'used energy-drain' });
  });
});
