import { describe, expect, test } from 'bun:test';
import { FLEE_WILDERNESS } from './fleeWilderness.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

const wildernessStatus = {
  boosts: {}, specialEnergy: 100, specialEnabled: false, runEnergy: 63, weight: 12,
  zoneTags: ['wilderness'], wildernessLevel: 7
};

describe('flee-wilderness', () => {
  test('enables run and walks south from a nearby player until zone exit', async () => {
    const ctx = new FakeContext(makeSnapshot({
      self: { at: { x: 3000, z: 3576, level: 0 }, status: wildernessStatus },
      nearby: [{ id: 2, kind: 'player', name: 'Pker', at: { x: 3002, z: 3576, level: 0 }, distance: 2, lastSeenTick: 0 }]
    }));
    const behaviour = FLEE_WILDERNESS.create({ radius: 4, southTiles: 8 });
    await behaviour.start(ctx);
    expect(ctx.intents.map((intent) => intent.type)).toEqual(['set-run', 'walk']);
    expect(ctx.intents.at(-1)).toMatchObject({ data: { dest: { x: 3000, z: 3568, level: 0 } } });

    ctx.inject(makeEvent('zone-left', { entity: 1, zone: 'wilderness' }));
    ctx.setSnapshot(makeSnapshot({ self: { at: { x: 3000, z: 3519, level: 0 }, status: {
      ...wildernessStatus, zoneTags: [], wildernessLevel: 0
    } } }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'left wilderness' });
  });
});
