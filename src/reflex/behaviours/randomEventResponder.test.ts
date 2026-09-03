import { describe, expect, test } from 'bun:test';
import { RANDOM_EVENT_RESPONDER } from './randomEventResponder.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('random-event-responder', () => {
  test('answers a prompt by matching its options', async () => {
    const ctx = new FakeContext();
    const behaviour = RANDOM_EVENT_RESPONDER.create({});
    ctx.inject(makeEvent('random-event-started', {
      entity: 1, event: 'sandwich-lady', prompt: 'Take the named snack: baguette.',
      options: ['Baguette', 'Triangle sandwich', 'Roll']
    }));
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'random-event', data: { action: 'respond', choice: 0 } });
    ctx.clearEvents();
    ctx.inject(makeEvent('random-event-ended', { entity: 1, event: 'sandwich-lady', outcome: 'success' }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'sandwich-lady success' });
  });

  test('dismisses a hostile event and flees ten tiles', async () => {
    const ctx = new FakeContext();
    const behaviour = RANDOM_EVENT_RESPONDER.create({});
    ctx.inject(makeEvent('random-event-started', {
      entity: 1, event: 'rock-golem', prompt: 'A rock golem attacks!'
    }));
    await behaviour.start(ctx);
    expect(ctx.intents).toHaveLength(2);
    expect(ctx.intents[0]).toMatchObject({ type: 'random-event', data: { action: 'dismiss' } });
    expect(ctx.intents[1]).toMatchObject({ type: 'run', data: { dest: { x: 3200, z: 3190, level: 0 } } });
  });
});
