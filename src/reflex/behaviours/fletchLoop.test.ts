import { describe, expect, test } from 'bun:test';
import { FLETCH_LOOP } from './fletchLoop.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('fletch-loop', () => {
  test('fails when fletching-stopped reports missing inputs', async () => {
    const ctx = new FakeContext(makeSnapshot());
    const behaviour = FLETCH_LOOP.create({ product: 52, amount: 3 });
    await behaviour.start(ctx);
    expect(ctx.intents[0]).toMatchObject({ type: 'fletch', data: { product: 52, amount: 3 } });
    ctx.inject(makeEvent('fletching-stopped', { entity: 1, reason: 'missing_ingredient' }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'failed', reason: 'missing_ingredient', retryable: false });
  });
});

