import { describe, expect, test } from 'bun:test';
import { FakeContext, makeSnapshot } from '../testing.ts';
import { WALK_TO } from './walkTo.ts';

describe('walk-to', () => {
  test('arrives, reissues until stuck, and fails unreachable', async () => {
    const behaviour = WALK_TO.create({ dest: { x: 2, z: 0, level: 0 } });
    const context = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } } }));
    expect((await behaviour.start(context)).state).toBe('running');
    context.setSnapshot(makeSnapshot({ self: { at: { x: 2, z: 0, level: 0 } } }));
    expect((await behaviour.step(context)).state).toBe('done');

    const stuck = WALK_TO.create({ dest: { x: 9, z: 0, level: 0 } });
    const stuckContext = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } } }));
    await stuck.start(stuckContext);
    let status;
    for (let index = 0; index < 6; index++) status = await stuck.step(stuckContext);
    expect(status).toMatchObject({ state: 'failed', reason: 'stuck' });

    const unreachable = WALK_TO.create({ dest: { x: 9, z: 0, level: 0 } });
    const unreachableContext = new FakeContext(makeSnapshot({
      self: { at: { x: 0, z: 0, level: 0 } }
    })).script({ ok: false, code: 'unreachable' });
    expect(await unreachable.start(unreachableContext)).toMatchObject({
      state: 'failed',
      retryable: false
    });
  });
});
