import { describe, expect, test } from 'bun:test';
import { MINIGAME_LOOP } from './minigameLoop.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('minigame-loop', () => {
  test('attacks an unshielded Pest Control portal and rejoins after a round', async () => {
    const ctx = new FakeContext();
    const behaviour = MINIGAME_LOOP.create({ game: 'pest-control', options: { tier: 'novice' }, rounds: 2 });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'minigame', data: { action: 'join', game: 'pest-control' } });
    ctx.inject(makeEvent('minigame-started', { game: 'pest-control', session: 'pc-1', players: [1] }));
    await behaviour.step(ctx);
    ctx.clearEvents();
    ctx.inject(makeEvent('minigame-event', {
      game: 'pest-control', session: 'pc-1', kind: 'portal-shield-dropped', data: { portal: 0, entity: 44 }
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'attack', data: { target: 44 } });
    ctx.clearEvents();
    ctx.inject(makeEvent('minigame-ended', { game: 'pest-control', session: 'pc-1', scores: [] }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'minigame', data: { action: 'join', game: 'pest-control' } });
  });

  test('searches a nearby Barrows sarcophagus after entering a crypt', async () => {
    const at = { x: 3557, z: 9703, level: 3 };
    const ctx = new FakeContext(makeSnapshot({ self: { at }, nearby: [{
      id: 70, kind: 'loc', loc: 6821, name: 'Sarcophagus', at, distance: 0, lastSeenTick: 1
    }] }));
    const behaviour = MINIGAME_LOOP.create({ game: 'barrows' });
    ctx.inject(makeEvent('minigame-started', { game: 'barrows', session: 'barrows-1', players: [1] }));
    await behaviour.start(ctx);
    ctx.clearEvents();
    ctx.inject(makeEvent('minigame-event', {
      game: 'barrows', session: 'barrows-1', entity: 1, kind: 'crypt-entered', data: { brother: 0 }
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'interact', data: {
      target: { kind: 'loc', at, loc: 6821 }, option: 'Search'
    } });
  });
});
