import { describe, expect, test } from 'bun:test';
import { FakeContext } from '../testing.ts';
import { WAIT } from './wait.ts';

describe('wait', () => {
  test('finishes after N pulses', async () => {
    const behaviour = WAIT.create({ ticks: 2 });
    const context = new FakeContext();
    expect((await behaviour.start(context)).state).toBe('running');
    expect((await behaviour.step(context)).state).toBe('done');
  });
});
