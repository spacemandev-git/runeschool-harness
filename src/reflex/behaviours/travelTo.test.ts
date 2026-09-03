import { describe, expect, test } from 'bun:test';
import { TRAVEL_TO } from './travelTo.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('travel-to', () => {
  test('walks to the departure loc, travels, and waits for arrival', async () => {
    const from = { at: { x: 3205, z: 3200, level: 0 }, loc: 14304 };
    const ctx = new FakeContext();
    const behaviour = TRAVEL_TO.create({ network: 'ship', from, destination: 'Karamja', run: true });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'run', data: { dest: from.at } });

    ctx.setSnapshot(makeSnapshot({ self: { at: { x: 3204, z: 3200, level: 0 } } }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({
      type: 'travel', data: { network: 'ship', from, destination: 'Karamja' }
    });

    ctx.inject(makeEvent('travelled', {
      entity: 1, network: 'ship', from: from.at,
      to: { x: 2956, z: 3143, level: 0 }, destination: 'Karamja'
    }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'travelled to Karamja' });
  });
});
