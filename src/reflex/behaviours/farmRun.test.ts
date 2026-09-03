import { describe, expect, test } from 'bun:test';
import { FARM_RUN } from './farmRun.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('farm-run', () => {
  test('prepares a patch, waits for growth, and harvests it', async () => {
    const plan = { id: 'falador-allotment-north', at: { x: 3201, z: 3200, level: 0 }, loc: 8550, seed: 5318, compost: 6032 };
    const ctx = new FakeContext(makeSnapshot());
    const behaviour = FARM_RUN.create({ patches: [plan] });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'farm', data: { action: 'rake' } });

    ctx.inject(makeEvent('farmed', { entity: 1, patch: plan.id, action: 'rake', item: 5341, xp: 12 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'farm', data: { action: 'compost', item: 6032 } });
    ctx.clearEvents();
    ctx.inject(makeEvent('farmed', { entity: 1, patch: plan.id, action: 'compost', item: 6032, xp: 18.5 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'farm', data: { action: 'plant', item: 5318 } });

    ctx.clearEvents();
    ctx.inject(makeEvent('farmed', { entity: 1, patch: plan.id, action: 'plant', item: 5318, xp: 8 }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'running', note: 'waiting for crops to grow' });
    ctx.clearEvents();
    ctx.inject(makeEvent('patch-changed', { entity: 1, patch: plan.id, at: plan.at, state: 'grown', crop: 5318, stage: 4 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'farm', data: { action: 'harvest' } });

    ctx.clearEvents();
    ctx.inject(
      makeEvent('patch-changed', { entity: 1, patch: plan.id, at: plan.at, state: 'empty' }),
      makeEvent('harvested', { entity: 1, patch: plan.id, item: 1942, amount: 1, xp: 9 }),
      makeEvent('farmed', { entity: 1, patch: plan.id, action: 'harvest', item: 1942, xp: 9 })
    );
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'harvested 1 items from 1 patches' });
  });
});
