import { describe, expect, test } from 'bun:test';
import { planRuleAction } from './ruleActions.ts';
import { FakeContext } from './testing.ts';

describe('adapter-neutral rule actions', () => {
  test('submits commands and wakes the mind', async () => {
    const context = new FakeContext();
    const engine = { async startBehaviour() {}, async stopBehaviour() { return true; } };
    const actionContext = Object.assign(context, { engine });
    await planRuleAction({ kind: 'command', type: 'recover', data: { amount: 1 } }, context.view.snapshot(), actionContext);
    await planRuleAction({ kind: 'wake-mind', note: 'state changed' }, context.view.snapshot(), actionContext);
    expect(context.intents[0]?.type).toBe('recover');
    expect(context.wakes[0]).toEqual({ reason: 'reflex-fired', note: 'state changed' });
  });
});
