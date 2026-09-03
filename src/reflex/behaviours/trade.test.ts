import { describe, expect, test } from 'bun:test';
import { TRADE } from './trade.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('trade', () => {
  test('requests, offers, accepts both stages, and completes', async () => {
    const partner = { id: 2, kind: 'player' as const, name: 'Partner', at: { x: 3201, z: 3200, level: 0 }, distance: 1, lastSeenTick: 0 };
    const ctx = new FakeContext(makeSnapshot({ nearby: [partner], inventory: [{ slot: 0, item: 995, amount: 10 }] }));
    const behaviour = TRADE.create({ target: 2, offer: [{ item: 995, amount: 5 }] });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'trade-request', data: { target: 2 } });

    ctx.inject(makeEvent('trade-opened', { a: 1, b: 2 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'trade-offer', data: { slot: 0, amount: 5 } });

    ctx.clearEvents();
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)?.type).toBe('trade-accept');

    ctx.clearEvents();
    ctx.inject(makeEvent('trade-stage', { a: 1, b: 2, stage: 'confirm' }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)?.type).toBe('trade-accept');

    ctx.clearEvents();
    ctx.inject(makeEvent('trade-completed', { a: 1, b: 2, aGave: [{ item: 995, amount: 5 }], bGave: [] }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.intents.map((intent) => intent.type)).toEqual(['trade-request', 'trade-offer', 'trade-accept', 'trade-accept']);
  });
});

