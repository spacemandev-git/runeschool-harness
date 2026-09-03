import { describe, expect, test } from 'bun:test';
import { COURSE_LOOP } from './courseLoop.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('course-loop', () => {
  test('traverses obstacles in order for the requested laps', async () => {
    const ctx = new FakeContext();
    const behaviour = COURSE_LOOP.create({ course: 'gnome-stronghold', obstacles: [0, 1], laps: 1 });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'traverse', data: { course: 'gnome-stronghold', obstacle: 0 } });
    ctx.inject(makeEvent('obstacle-completed', { entity: 1, course: 'gnome-stronghold', obstacle: 0, xp: 7.5 }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'traverse', data: { course: 'gnome-stronghold', obstacle: 1 } });
    ctx.clearEvents();
    ctx.inject(makeEvent('obstacle-completed', { entity: 1, course: 'gnome-stronghold', obstacle: 1, xp: 7.5 }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'completed 1 gnome-stronghold laps' });
  });
});
