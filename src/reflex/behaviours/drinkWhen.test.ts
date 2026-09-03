import { describe, expect, test } from 'bun:test';
import { DRINK_WHEN } from './drinkWhen.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('drink-when', () => {
  test('drinks a named potion at the HP threshold and completes on drank', async () => {
    const ctx = new FakeContext(makeSnapshot({
      self: { hp: { current: 4, max: 10 } },
      inventory: [{ slot: 3, item: 2434, name: 'Prayer potion(4)', amount: 1 }]
    }));
    const behaviour = DRINK_WHEN.create({ potion: 'prayer potion', hpBelow: 0.5 });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'running' });
    expect(ctx.intents).toContainEqual(expect.objectContaining({ type: 'drink', data: { item: 2434 } }));
    ctx.inject(makeEvent('drank', { entity: 1, item: 2434, product: 139 }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'drank prayer potion' });
  });

  test('can wait specifically for poison', async () => {
    const safe = makeSnapshot({ inventory: [{ slot: 0, item: 2446, name: 'Antipoison(4)', amount: 1 }] });
    const ctx = new FakeContext(safe);
    const behaviour = DRINK_WHEN.create({ potion: 'antipoison', whenPoisoned: true });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'running', note: 'waiting for threshold' });
    ctx.setSnapshot(makeSnapshot({ ...safe, self: { status: {
      boosts: {}, specialEnergy: 100, specialEnabled: false, runEnergy: 100, weight: 0,
      poison: { severity: 12 }, zoneTags: [], wildernessLevel: 0
    } } }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'drink', data: { item: 2446 } });
  });
});
