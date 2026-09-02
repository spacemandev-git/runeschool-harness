import { describe, expect, test } from 'bun:test';
import type { WakeReason } from '../core/types.ts';
import { createWakePolicy } from './wakePolicy.ts';

class Timers {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, delay: number): number => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };
  clear = (handle: unknown): void => { this.tasks.delete(handle as number); };
  advance(ms: number): void {
    this.now += ms;
    while (true) {
      const ready = [...this.tasks].filter(([, task]) => task.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (ready === undefined) return;
      this.tasks.delete(ready[0]);
      ready[1].callback();
    }
  }
}

const config = { minIntervalMs: 10, heartbeatMs: 50, hpAlertFraction: 0.5, maxTurns: 0, maxToolCallsPerWake: 4 };
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('wake policy', () => {
  test('single-flights and coalesces requests during a turn into one ordered follow-up', async () => {
    const timers = new Timers();
    const calls: { reasons: readonly WakeReason[]; note?: string }[] = [];
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const policy = createWakePolicy(config, {
      now: () => timers.now, setTimeout: timers.set, clearTimeout: timers.clear,
      run: async (reasons, note) => { calls.push({ reasons, ...(note === undefined ? {} : { note }) }); if (calls.length === 1) await firstGate; }
    });
    const first = policy.request('operator');
    const second = policy.request('message', 'one');
    const third = policy.request('message', 'two');
    expect(calls).toHaveLength(1);
    release();
    await first;
    await flush();
    expect(calls).toHaveLength(1);
    timers.advance(10);
    await Promise.all([second, third]);
    expect(calls).toEqual([
      { reasons: ['operator'] },
      { reasons: ['message'], note: 'one; two' }
    ]);
  });

  test('arms and disarms heartbeat and respects max turns', async () => {
    const timers = new Timers();
    const reasons: WakeReason[][] = [];
    const policy = createWakePolicy({ ...config, maxTurns: 1 }, {
      now: () => timers.now, setTimeout: timers.set, clearTimeout: timers.clear,
      run: async (value) => { reasons.push([...value]); }
    });
    policy.setActive(true);
    timers.advance(49);
    expect(reasons).toEqual([]);
    timers.advance(1);
    await flush();
    expect(reasons).toEqual([['heartbeat']]);
    await policy.request('operator');
    expect(reasons).toHaveLength(1);
    policy.setActive(false);
    timers.advance(100);
    expect(reasons).toHaveLength(1);
  });
});
