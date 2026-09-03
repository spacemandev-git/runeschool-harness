import { describe, expect, test } from 'bun:test';
import { INTERACT } from './interact.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('interact', () => {
  test('walks to the target and waits for matching evidence', async () => {
    const npc = { id: 12, kind: 'npc' as const, name: 'Man', at: { x: 3, z: 0, level: 0 }, distance: 3, lastSeenTick: 0 };
    const ctx = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc] }));
    const behaviour = INTERACT.create({ target: { kind: 'npc', id: 12 }, option: 'Talk-to' });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'running' });
    expect(ctx.intents[0]?.type).toBe('walk');
    ctx.setSnapshot(makeSnapshot({ self: { at: { x: 2, z: 0, level: 0 } }, nearby: [{ ...npc, distance: 1 }] }));
    await behaviour.step(ctx);
    expect(ctx.intents[1]).toMatchObject({ type: 'interact', data: { target: { kind: 'npc', id: 12 }, option: 'Talk-to' } });
    ctx.inject(makeEvent('interacted', { entity: 1, target: { kind: 'npc', id: 12 }, option: 'Talk-to', handler: 'core' }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'done' });
  });

  test('treats no_handler as non-retryable', async () => {
    const npc = { id: 12, kind: 'npc' as const, at: { x: 1, z: 0, level: 0 }, distance: 1, lastSeenTick: 0 };
    const ctx = new FakeContext(makeSnapshot({ self: { at: { x: 0, z: 0, level: 0 } }, nearby: [npc] })).script({ ok: false, code: 'no_handler' });
    const behaviour = INTERACT.create({ target: { kind: 'npc', id: 12 }, option: 'Inspect' });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'failed', reason: 'no_handler', retryable: false });
  });
});

