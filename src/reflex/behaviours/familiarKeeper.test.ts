import { describe, expect, test } from 'bun:test';
import { FAMILIAR_KEEPER } from './familiarKeeper.ts';
import { FakeContext, makeEvent, makeSnapshot } from '../testing.ts';

describe('familiar-keeper', () => {
  test('summons and renews before the folded expiry', async () => {
    const ctx = new FakeContext();
    const behaviour = FAMILIAR_KEEPER.create({ pouch: 12047, renewBeforeTicks: 100 });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'summon', data: { action: 'summon', item: 12047 } });
    ctx.setSnapshot(makeSnapshot({ familiar: { id: 30, pouch: 12047, expiresAt: 600 } }));
    ctx.inject(makeEvent('familiar-summoned', { entity: 1, familiar: 30, pouch: 12047, expiresAt: 600 }));
    await behaviour.step(ctx);
    ctx.clearEvents();
    ctx.advance(501);
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'summon', data: { action: 'renew', item: 12047 } });
  });

  test('dismisses on request', async () => {
    const ctx = new FakeContext(makeSnapshot({ familiar: { id: 30, pouch: 12047, expiresAt: 600 } }));
    const behaviour = FAMILIAR_KEEPER.create({ pouch: 12047, dismiss: true });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'summon', data: { action: 'dismiss' } });
    ctx.inject(makeEvent('familiar-dismissed', { entity: 1, familiar: 30, reason: 'dismissed' }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'familiar dismissed' });
  });
});
