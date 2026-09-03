import { describe, expect, test } from 'bun:test';
import { SLAYER_LOOP } from './slayerLoop.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('slayer-loop', () => {
  test('requests a task, attacks assigned NPC configs, and completes', async () => {
    const banshee = { id: 9, kind: 'npc' as const, npc: 1612, name: 'Banshee', at: { x: 3201, z: 3200, level: 0 }, distance: 1, hp: { current: 22, max: 22 }, lastSeenTick: 0 };
    const ctx = new FakeContext(makeSnapshot({ nearby: [banshee] }));
    const behaviour = SLAYER_LOOP.create({ master: 8, radius: 10 });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'slayer-task', data: { master: 8 } });

    ctx.inject(makeEvent('slayer-assigned', {
      entity: 1, master: 8, task: 'Banshees', npcs: [1612], amount: 2
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'attack', data: { target: 9 } });

    ctx.clearEvents();
    ctx.inject(makeEvent('slayer-kill', { entity: 1, task: 'Banshees', remaining: 1 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'attack', data: { target: 9 } });

    ctx.clearEvents();
    ctx.inject(makeEvent('slayer-complete', { entity: 1, task: 'Banshees', points: 2, streak: 1 }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'Banshees task complete; streak 1' });
  });
});
