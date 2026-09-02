import { describe, expect, test } from 'bun:test';
import { FakeContext } from '../testing.ts';
import { BUILTIN_BEHAVIOURS } from './index.ts';

describe('sequence', () => {
  test('runs child behaviours in order', async () => {
    const definition = BUILTIN_BEHAVIOURS.find((value) => value.id === 'sequence')!;
    const behaviour = definition.create({
      steps: [
        { behaviour: 'wait', params: { ticks: 1 } },
        { behaviour: 'wait', params: { ticks: 2 } }
      ]
    });
    const context = new FakeContext();
    expect((await behaviour.start(context)).state).toBe('running');
    expect((await behaviour.step(context)).state).toBe('done');
  });

  test('validates children', () => {
    const definition = BUILTIN_BEHAVIOURS.find((value) => value.id === 'sequence')!;
    expect(definition.validate({
      steps: [{ behaviour: 'missing', params: {} }]
    }).ok).toBeFalse();
  });
});
