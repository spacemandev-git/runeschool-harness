import { describe, expect, test } from 'bun:test';
import { TRAP_LOOP } from './trapLoop.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('trap-loop', () => {
  test('lays the requested traps, checks a catch, and re-lays', async () => {
    const ctx = new FakeContext();
    const behaviour = TRAP_LOOP.create({ item: 10006, count: 2 });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'hunt', data: { action: 'lay-trap', item: 10006 } });
    ctx.inject(makeEvent('trap-laid', { entity: 1, trap: 20, kind: 'bird-snare' }));
    await behaviour.step(ctx);
    expect(ctx.intents).toHaveLength(2);
    ctx.clearEvents();
    ctx.inject(makeEvent('trap-laid', { entity: 1, trap: 21, kind: 'bird-snare' }));
    await behaviour.step(ctx);
    expect(ctx.intents).toHaveLength(2);

    ctx.clearEvents();
    ctx.inject(makeEvent('trap-caught', { entity: 1, trap: 20, catch: 9978 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'hunt', data: { action: 'check-trap', target: { kind: 'npc', id: 20 } } });
    ctx.clearEvents();
    ctx.inject(makeEvent('hunted', { entity: 1, item: 9978, xp: 34 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'hunt', data: { action: 'lay-trap' } });
  });
});
