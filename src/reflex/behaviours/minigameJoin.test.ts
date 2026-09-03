import { describe, expect, test } from 'bun:test';
import { MINIGAME_JOIN } from './minigameJoin.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('minigame-join', () => {
  test('joins, readies, and reports the end result', async () => {
    const ctx = new FakeContext();
    const behaviour = MINIGAME_JOIN.create({ game: 'fight-caves' });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'minigame', data: { action: 'join', game: 'fight-caves' } });
    ctx.inject(makeEvent('minigame-lobby', { game: 'fight-caves', players: [{ entity: 1, ready: false }], state: 'waiting' }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'minigame', data: { action: 'ready', game: 'fight-caves' } });
    ctx.clearEvents();
    ctx.inject(makeEvent('minigame-started', { game: 'fight-caves', session: 'fight-caves-1', players: [1] }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'running', note: 'fight-caves session fight-caves-1' });
    ctx.clearEvents();
    ctx.inject(makeEvent('minigame-ended', { game: 'fight-caves', session: 'fight-caves-1', winner: 1, scores: [{ entity: 1, score: 63 }] }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'fight-caves ended; won' });
    expect(ctx.wakes.at(-1)?.note).toContain('ended with a win');
  });
});
