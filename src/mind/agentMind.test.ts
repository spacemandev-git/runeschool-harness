import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { Mailbox, MindDeps } from '../core/agent.ts';
import type { MemoryRecord, MemoryStore } from '../core/memory.ts';
import type { ModelConfig, ModelProvider } from '../core/model.ts';
import { assistantText, assistantToolCall, createMockProvider, type MockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createReflexEngine, FakeView, makeSnapshot } from '../reflex/index.ts';
import { createAgentMind } from './agentMind.ts';

function config(): ModelConfig {
  const spec = { provider: 'mock', model: 'test' };
  return { providers: { mock: { kind: 'mock' } }, roles: {
    director: spec, coordinator: spec, agent: spec, summarizer: spec, admin: spec
  } };
}

function memory(): MemoryStore {
  const rows: MemoryRecord[] = [];
  return {
    agentId: 'alice',
    async remember(input) {
      const row: MemoryRecord = { id: rows.length + 1, agentId: 'alice', kind: input.kind, text: input.text,
        tags: input.tags ?? [], importance: input.importance ?? 0.5, runId: 'run-test', createdAt: 0, recallCount: 0 };
      rows.push(row); return row;
    },
    async recall() { return []; }, async forget() { return false; }, async update() { return undefined; },
    async recent() { return []; }, async count() { return rows.length; }, close() {}
  };
}

function fixture(provider: ModelProvider) {
  const bus = createBus();
  const view = new FakeView(makeSnapshot({ tick: 1234, self: { at: { x: 3222, z: 3218, level: 0 }, hp: { current: 12, max: 20 } } }), 'alice');
  const submitted: string[] = [];
  const states: string[] = [];
  const finishes: { success: boolean; summary: string }[] = [];
  const mailbox: Mailbox = { send() {}, drain: () => [], pending: () => 0 };
  const deps: MindDeps = {
    agentId: 'alice', spec: { id: 'alice', displayName: 'Alice' }, view,
    sink: { async submit(intent) { submitted.push(intent.type); return { intent, ok: true, tick: 1234, sentAt: 1 }; } },
    reflexes: createReflexEngine({ agentId: 'alice', bus }), memory: memory(),
    models: createModelRegistry(config(), { bus, providers: { mock: provider } }),
    prompts: createPromptLibrary(), bus, mailbox, commandTypes: ['walk', 'wait'],
    worldContext: { kind: 'simulation', region: { id: 1, name: 'Training Grounds' }, spawn: { x: 12, z: 8, level: 0 } },
    worldReads: { async scan() { return []; } },
    wake: { minIntervalMs: 1, heartbeatMs: 60_000, hpAlertFraction: 0.5, maxTurns: 0, maxToolCallsPerWake: 6 },
    context: { maxPromptTokens: 30_000, compactAtTokens: 25_000, keepTurns: 2, recallLimit: 3 },
    onFinished(success, summary) {
      finishes.push({ success, summary }); states.push('finished');
      bus.emit('agent.state', { agentId: 'alice', state: 'finished', detail: summary });
      bus.emit('agent.finished', { agentId: 'alice', success, summary });
    },
    setState(state, detail) {
      states.push(state);
      bus.emit('agent.state', { agentId: 'alice', state, ...(detail === undefined ? {} : { detail }) });
    }
  };
  return { mind: createAgentMind(deps), bus, submitted, states, finishes, view };
}

class CheckpointView extends FakeView {
  currentCheckpoint = 0;
  deltaLine = '';
  override checkpoint(): number { return this.currentCheckpoint; }
  override deltaSince(since: number) {
    const delta = super.deltaSince(since);
    return { ...delta, toSeq: this.currentCheckpoint, messages: since < this.currentCheckpoint && this.deltaLine.length > 0 ? [this.deltaLine] : [] };
  }
}

function pauseFixture(blind: boolean) {
  const mock = createMockProvider();
  mock.enqueue(assistantText('initial'));
  mock.enqueue(assistantText('resumed'));
  const built = fixture(mock);
  const view = built.view as FakeView;
  const checkpoint = new CheckpointView(view.snapshot(), 'alice');
  // The Mind captures its view at construction, so replace the methods on the existing fake.
  let currentCheckpoint = 0;
  let deltaLine = '';
  view.checkpoint = () => currentCheckpoint;
  view.deltaSince = (since) => ({
    ...checkpoint.deltaSince(since), toSeq: currentCheckpoint,
    messages: since < currentCheckpoint && deltaLine.length > 0 ? [deltaLine] : []
  });
  return {
    ...built, mock, blind,
    changeDuringPause(line: string) { deltaLine = line; currentCheckpoint++; }
  };
}

describe('agent mind', () => {
  test('goal wake observes, acts, pushes the tool result, then sleeps idle', async () => {
    const mock = createMockProvider();
    mock.enqueue(assistantToolCall('act', { type: 'walk', data: { dest: { x: 3223, z: 3218, level: 0 } } }, 'act-1'));
    mock.enqueue(assistantToolCall('sleep', { reason: 'waiting' }, 'sleep-1'));
    const { mind, bus, submitted, states } = fixture(mock);
    await mind.setGoal('Walk east.', 'operator');
    expect(submitted).toEqual(['walk']);
    expect(mock.requests[0]?.messages.at(-1)?.content).toContain('World test-instance — tick 1234');
    expect(mock.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'act-1')).toBe(true);
    expect(states.at(-1)).toBe('idle');
    const eventTypes = bus.history().map((event) => event.type);
    for (const type of ['agent.mind.wake', 'agent.mind.turn', 'agent.mind.tool', 'agent.state'] as const) {
      expect(eventTypes).toContain(type);
    }
    expect(mind.status()).toMatchObject({ turns: 1, busy: false, lastReasons: ['goal-assigned'] });
    expect(mind.transcript()[0]?.role).toBe('system');
    await mind.dispose();
  });

  test('finish permanently sets finished and invokes the callback', async () => {
    const mock = createMockProvider();
    mock.enqueue(assistantToolCall('finish', { success: true, summary: 'Objective complete.' }));
    const { mind, finishes, states } = fixture(mock);
    await mind.setGoal('Win.', 'config');
    expect(finishes).toEqual([{ success: true, summary: 'Objective complete.' }]);
    expect(states.at(-1)).toBe('finished');
    const turns = mind.status().turns;
    await mind.wake('operator');
    expect(mind.status().turns).toBe(turns);
    await mind.dispose();
  });

  test('chat errors do not escape and apply failure backoff', async () => {
    const failing: ModelProvider = { id: 'mock', async chat() { throw new Error('scripted failure'); } };
    const { mind, bus, states } = fixture(failing);
    const started = Date.now();
    await expect(mind.setGoal('Try safely.', 'operator')).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(3);
    expect(states.at(-1)).toBe('idle');
    expect(bus.history().some((event) => event.type === 'log' && event.data.level === 'error')).toBe(true);
    await mind.dispose();
  });

  test('two wakes during a running chat coalesce into one follow-up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ModelProvider = {
      id: 'mock',
      async chat(request) {
        calls++;
        if (calls === 1) await gate;
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', latencyMs: 0, model: request.model };
      }
    };
    const { mind } = fixture(provider);
    const first = mind.setGoal('Wait.', 'operator');
    await Promise.resolve();
    const second = mind.wake('operator', 'a');
    const third = mind.wake('message', 'b');
    release();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    expect(mind.status().turns).toBe(2);
    await mind.dispose();
  });

  test('blind resume hides paused world deltas while non-blind resume backfills them', async () => {
    for (const blind of [true, false]) {
      const run = pauseFixture(blind);
      await run.mind.setGoal('Observe.', 'operator');
      run.bus.emit('agent.state', { agentId: 'alice', state: 'paused' });
      run.changeDuringPause('private paused movement');
      run.bus.emit('agent.state', { agentId: 'alice', state: 'idle' });
      await run.mind.wake('resumed', blind ? 'resumed (blind)' : undefined);
      const digest = run.mock.requests[1]?.messages.at(-1)?.content ?? '';
      expect(digest.includes('private paused movement')).toBe(!blind);
      if (blind) expect(digest).toContain('Note: resumed (blind)');
      await run.mind.dispose();
    }
  });
});
