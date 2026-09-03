import { describe, expect, test } from 'bun:test';
import { USE_ITEM_ON } from './useItemOn.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('use-item-on', () => {
  test('uses an occupied slot and waits for item-used', async () => {
    const player = { id: 2, kind: 'player' as const, at: { x: 1, z: 0, level: 0 }, distance: 1, lastSeenTick: 0 };
    const ctx = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [player], inventory: [{ slot: 3, item: 946, amount: 1 }] }));
    const behaviour = USE_ITEM_ON.create({ slot: 3, target: { kind: 'player', id: 2 } });
    await behaviour.start(ctx);
    expect(ctx.intents[0]).toMatchObject({ type: 'use-item-on', data: { slot: 3 } });
    ctx.inject(makeEvent('item-used', { entity: 1, item: 946, target: { kind: 'player', id: 2 }, handler: 'fletching' }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'done' });
  });
});
