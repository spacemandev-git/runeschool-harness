import { describe, expect, test } from 'bun:test';
import { RUNECRAFT_LOOP } from './runecraftLoop.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('runecraft-loop', () => {
  test('enters with a talisman, crafts at the altar, and completes', async () => {
    const ruin = { at: { x: 3201, z: 3200, level: 0 }, loc: 2452 };
    const altar = { at: { x: 2841, z: 4829, level: 0 }, loc: 2478 };
    const ctx = new FakeContext(makeSnapshot({ inventory: [
      { slot: 0, item: 1438, name: 'Air talisman', amount: 1 },
      { slot: 1, item: 1436, name: 'Rune essence', amount: 10 }
    ] }));
    const behaviour = RUNECRAFT_LOOP.create({ talisman: 1438, ruin, altar });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'enter-ruin', data: { ruin } });

    ctx.setSnapshot(makeSnapshot({ self: { at: { x: 2841, z: 4828, level: 0 } }, inventory: ctx.view.snapshot().inventory }));
    ctx.inject(makeEvent('ruin-entered', { entity: 1, altar: 'air' }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'craft-runes', data: { altar } });

    ctx.clearEvents();
    ctx.inject(makeEvent('runes-crafted', { entity: 1, rune: 556, amount: 10, xp: 50 }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'crafted 10 runes' });
  });
});
