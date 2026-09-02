import { describe, expect, test } from 'bun:test';
import { makeSnapshot } from './testing.ts';
import { evaluate, validateRule } from './dsl.ts';

describe('adapter-neutral reflex DSL', () => {
  test('validates generic commands and known behaviours', () => {
    expect(validateRule({
      id: 'low-health', priority: 10,
      when: { op: 'lt', ref: 'self.hp.fraction', value: 0.5 },
      do: [{ kind: 'command', type: 'recover', data: {} }]
    })).toEqual({ ok: true, errors: [] });
    expect(validateRule({
      id: 'start', priority: 1, when: { op: 'true' },
      do: [{ kind: 'start-behaviour', behaviour: 'missing', params: {} }]
    }, new Set(['wait']))).toMatchObject({ ok: false });
  });

  test('evaluates snapshot and event expressions', () => {
    const snapshot = makeSnapshot({ tick: 10, self: { hp: { current: 4, max: 10 } } });
    expect(evaluate({ op: 'lt', ref: 'self.hp.fraction', value: 0.5 }, snapshot, [], { behaviourRunning: () => false })).toBe(true);
    expect(evaluate({ op: 'event', type: 'alert', withinTicks: 2 }, snapshot,
      [{ type: 'alert', tick: 9, seq: 1, data: {} }], { behaviourRunning: () => false })).toBe(true);
  });
});
