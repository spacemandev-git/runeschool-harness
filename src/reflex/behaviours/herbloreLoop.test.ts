import { describe, expect, test } from 'bun:test';
import { HERBLORE_LOOP } from './herbloreLoop.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('herblore-loop', () => {
  test('cleans an entire selected herb stack when amount is omitted', async () => {
    const ctx = new FakeContext(makeSnapshot());
    const behaviour = HERBLORE_LOOP.create({ action: 'clean', item: 199 });
    await behaviour.start(ctx);
    expect(ctx.intents[0]).toMatchObject({ type: 'clean-herb', data: { item: 199 } });
    ctx.inject(makeEvent('herblore-stopped', { entity: 1, reason: 'completed' }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'done' });
  });
});

