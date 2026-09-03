import { describe, expect, test } from 'bun:test';
import { ACTOR_COMMAND_TYPES, TICK_MILLIS, type JsonValue, type SimEvent } from '#protocol';
import { createBus } from '../bus/index.ts';
import { AGENT_DENIED_COMMANDS } from '../core/actions.ts';
import type {
  DefsReader, MemoryStore, Mind, MindDeps, ModelRegistry, PromptLibrary, ReflexContext,
  ReflexEngine, ReflexEngineState, Rule, ValidationResult
} from '../core/index.ts';
import { FakeActorLink, makeSnapshot } from '../perception/testing.ts';
import { FakeView } from '../reflex/testing.ts';
import { createMailboxes } from './mailbox.ts';
import { createAgentRuntime } from './agentRuntime.ts';

function memory(): MemoryStore {
  return {
    agentId: 'hero', async remember(input) { return { id: 1, agentId: 'hero', kind: input.kind, text: input.text, tags: [], importance: 0.5, runId: 'run-test', createdAt: 0, recallCount: 0 }; },
    async recall() { return []; }, async forget() { return false; }, async update() { return undefined; },
    async recent() { return []; }, async count() { return 0; }, close() {}
  };
}
function emptyState(): ReflexEngineState { return { rules: [], queue: [] }; }

describe('agent runtime', () => {
  test('handles lifecycle events and pulses even while paused', async () => {
    const bus = createBus();
    const link = new FakeActorLink({ entity: 1, tag: 'hero' });
    const view = new FakeView(makeSnapshot({ self: { ...makeSnapshot().self, entity: 1, tag: 'hero' } }), 'hero');
    let pulseEvents: readonly SimEvent[] = [];
    const model = Object.assign(view, {
      async start() {}, stop() {}, async resync() {}, noteRejection() {},
      lastPulseEvents() { const result = pulseEvents; pulseEvents = []; return result; }
    });
    const pulses: ReflexContext[] = [];
    const engine: ReflexEngine = {
      installRule(_rule: Rule): ValidationResult { return { ok: true, errors: [] }; },
      removeRule() { return false; }, setRuleEnabled() { return false; }, listBehaviours() { return []; },
      async startBehaviour() { return { ok: false, errors: [] }; }, async stopBehaviour() { return false; },
      state: emptyState,
      async pulse(ctx) { pulses.push(ctx); ctx.wakeMind('reflex-fired', 'wake'); }
    };
    const wakes: string[] = []; let disposed = false;
    let mindDeps: MindDeps | undefined;
    const mindFactory = (deps: MindDeps): Mind => {
      mindDeps = deps;
      return {
        async wake(reason) { wakes.push(reason); }, async setGoal() {}, async say() {},
        status: () => ({ turns: 0, lastReasons: [], promptTokensEstimate: 0, historyMessages: 0, compactions: 0, busy: false }),
        transcript: () => [], async dispose() { disposed = true; }
      };
    };
    let interval: (() => void) | undefined;
    const runtime = createAgentRuntime({
      runId: 'run-test', spec: { id: 'hero' }, credentials: link.credentials, worldContext: {}, bus,
      models: {} as ModelRegistry, prompts: {} as PromptLibrary,
      memoryFactory: { open: () => memory() }, mindFactory, mailboxes: createMailboxes(bus),
      mcp: { url: '', async connect() {}, tools: () => [], async call(): Promise<JsonValue> { return {}; }, async provision() { throw new Error(); }, async addPlayer() { throw new Error(); }, async close() {} },
      createLink: () => link,
      createDefs: () => ({ async names() { return { items: {}, npcs: {} }; }, async region() { return {}; } }) as DefsReader,
      createModel: () => model,
      createReflexes: () => engine,
      setInterval: ((callback: () => void) => { interval = callback; return 1; }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval
    });
    await runtime.start();
    expect(runtime.state).toBe('idle');
    expect(interval).toBeDefined();
    expect(mindDeps?.commandTypes).toBe(ACTOR_COMMAND_TYPES);
    expect(mindDeps?.deniedCommandTypes).toBe(AGENT_DENIED_COMMANDS);
    expect(mindDeps?.pulseMs).toBe(TICK_MILLIS);
    await runtime.pulseNow();
    expect(pulses).toHaveLength(1);
    expect(pulses[0]?.view).toBe(model);
    expect(wakes).toContain('reflex-fired');

    runtime.pause();
    await runtime.pulseNow();
    expect(runtime.state).toBe('paused');
    expect(pulses).toHaveLength(2);

    link.emit({ type: 'died', tick: 11, seq: 1, data: { entity: 1 } } as SimEvent);
    expect(runtime.state).toBe('dead');
    expect(wakes).toContain('salient-event');
    link.emit({ type: 'respawned', tick: 17, seq: 2, data: { entity: 1, at: { x: 1, z: 1, level: 0 } } } as SimEvent);
    expect(runtime.state).toBe('paused');
    runtime.resume();
    expect(runtime.state).toBe('idle');

    mindDeps!.onFinished(true, 'done');
    expect(runtime.state).toBe('finished');
    expect(runtime.finishedResult).toEqual({ success: true, summary: 'done' });
    await runtime.stop();
    expect(disposed).toBe(true);
  });

  test('marks an unexpected link close errored', async () => {
    const bus = createBus(); const link = new FakeActorLink(); const view = new FakeView();
    const runtime = createAgentRuntime({
      runId: 'run-test', spec: { id: 'hero' }, credentials: link.credentials, worldContext: {}, bus,
      models: {} as ModelRegistry, prompts: {} as PromptLibrary, memoryFactory: { open: () => memory() },
      mindFactory: () => ({ async wake() {}, async setGoal() {}, async say() {}, status: () => ({ turns: 0, lastReasons: [], promptTokensEstimate: 0, historyMessages: 0, compactions: 0, busy: false }), transcript: () => [], async dispose() {} }),
      mailboxes: createMailboxes(bus), mcp: { url: '', async connect() {}, tools: () => [], async call() { return {}; }, async provision() { throw new Error(); }, async addPlayer() { throw new Error(); }, async close() {} },
      createLink: () => link, createDefs: () => ({ async names() { return { items: {}, npcs: {} }; }, async region() { return {}; } }),
      createModel: () => Object.assign(view, { async start() {}, stop() {}, async resync() {}, noteRejection() {}, lastPulseEvents() { return []; } }),
      createReflexes: () => ({ installRule: () => ({ ok: true, errors: [] }), removeRule: () => false, setRuleEnabled: () => false, listBehaviours: () => [], async startBehaviour() { return { ok: false, errors: [] }; }, async stopBehaviour() { return false; }, state: emptyState, async pulse() {} }),
      setInterval: (() => 1) as unknown as typeof setInterval, clearInterval: (() => {}) as typeof clearInterval
    });
    await runtime.start(); await link.close();
    expect(runtime.state).toBe('errored');
    await runtime.stop();
  });
});
