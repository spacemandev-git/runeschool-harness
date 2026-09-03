import { describe, expect, test } from 'bun:test';
import { DIARY_TRACKER } from './diaryTracker.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('diary-tracker', () => {
  test('queries an area and exposes its next incomplete easy task', async () => {
    const ctx = new FakeContext();
    const behaviour = DIARY_TRACKER.create({ area: 'lumbridge' });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'diary', data: { area: 'lumbridge' } });
    ctx.inject(makeEvent('diary-progress', {
      entity: 1, area: 'lumbridge', level: 'easy', done: 1, total: 3,
      tasks: [
        { id: 'lumbridge-easy-01', text: 'Cook a shrimp.', done: true },
        { id: 'lumbridge-easy-02', text: 'Mine copper.', done: false }
      ]
    }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'running', note: 'Next easy diary task (lumbridge): Mine copper.' });
    expect(ctx.wakes.at(-1)).toEqual({ reason: 'reflex-fired', note: 'Next easy diary task (lumbridge): Mine copper.' });
  });
});
