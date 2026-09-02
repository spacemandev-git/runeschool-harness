import { describe, expect, test } from 'bun:test';
import type { AgentSummary } from '../core/runtime.ts';
import { createBus } from '../bus/index.ts';
import { createFakeRuntime } from './fake/fakeRuntime.ts';
import { agentRow, eventLine, snapshotText } from './format.ts';
import { hpMeter } from './theme.ts';

const agent: AgentSummary = {
  id: 'an-agent-with-a-very-long-id', displayName: 'Agent', tag: 'agent', entity: 1, team: 'alpha',
  state: 'acting', goal: 'A goal that cannot possibly fit', model: 'long-model-name',
  hp: { current: 7, max: 10 }, at: { x: 3222, z: 3218, level: 0 }, activity: 'walking',
  behaviour: 'walk-to-somewhere', turns: 12, lastWakeAt: 1_700_000_000_000,
};

describe('formatters', () => {
  test('agent rows fit their target and truncate', () => {
    const row = agentRow(agent, 80);
    expect(row.length).toBeLessThanOrEqual(80);
    expect(row).toContain('…');
    expect(agentRow(agent, 20).length).toBeLessThanOrEqual(20);
  });

  test('hp meter clamps boundary values', () => {
    expect(hpMeter(0, 10, 5)).toBe('[░░░░░]');
    expect(hpMeter(10, 10, 5)).toBe('[█████]');
    expect(hpMeter(15, 10, 5)).toBe('[█████]');
  });

  test('event lines compact to 160 characters', () => {
    const bus = createBus();
    bus.emit('log', { level: 'info', scope: 'test', message: 'x'.repeat(500) });
    const event = bus.history()[0];
    expect(event).toBeDefined();
    expect(eventLine(event!)).toHaveLength(160);
  });

  test('snapshot text is human-readable rather than JSON', () => {
    const bus = createBus();
    const fake = createFakeRuntime(bus, { seed: 1 });
    const snapshot = fake.view.agentSnapshot('hero');
    expect(snapshot).toBeDefined();
    const text = snapshotText(snapshot!);
    expect(text).toContain('inventory');
    expect(text).not.toContain('{');
    expect(text).not.toContain('}');
  });
});
