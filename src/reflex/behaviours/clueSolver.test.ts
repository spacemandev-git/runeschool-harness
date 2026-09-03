import { describe, expect, test } from 'bun:test';
import { CLUE_SOLVER } from './clueSolver.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('clue-solver', () => {
  test('reads, walks to a coordinate, and digs', async () => {
    const destination = { x: 3209, z: 3215, level: 0 };
    const ctx = new FakeContext();
    const behaviour = CLUE_SOLVER.create({ item: 2677, locations: { 'easy:0': destination } });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'clue', data: { action: 'read', item: 2677 } });
    ctx.inject(makeEvent('clue-step', {
      entity: 1, tier: 'easy', step: 0, kind: 'coordinate', text: '00 degrees north.'
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'walk', data: { dest: destination } });
    ctx.clearEvents();
    ctx.setSnapshot(makeSnapshot({ self: { at: destination } }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'clue', data: { action: 'dig' } });
  });

  test('uses configured emotes and talks to a cryptic NPC before answering', async () => {
    const at = { x: 3212, z: 3463, level: 0 };
    const emoteCtx = new FakeContext(makeSnapshot({ self: { at } }));
    const emote = CLUE_SOLVER.create({ locations: { courtyard: at }, emotes: { courtyard: 'spin' } });
    emoteCtx.inject(makeEvent('clue-step', { entity: 1, tier: 'easy', step: 1, kind: 'emote', text: 'Spin in the courtyard.' }));
    await emote.start(emoteCtx);
    expect(emoteCtx.intents.at(-1)).toMatchObject({ type: 'clue', data: { action: 'emote', emote: 'spin' } });

    const crypticCtx = new FakeContext();
    const cryptic = CLUE_SOLVER.create({ npcs: { Larxus: 42 } });
    crypticCtx.inject(makeEvent('clue-step', { entity: 1, tier: 'hard', step: 2, kind: 'cryptic', text: "Talk to the keeper of the Champions' Guild challenge." }));
    await cryptic.start(crypticCtx);
    expect(crypticCtx.intents.at(-1)).toMatchObject({ type: 'talk-to', data: { npc: 42 } });
    crypticCtx.clearEvents();
    await cryptic.step(crypticCtx);
    expect(crypticCtx.intents.at(-1)).toMatchObject({ type: 'clue', data: { action: 'answer', answer: 'Larxus' } });
  });
});
