import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../bus/index.ts';
import type {
  McpSession,
  MemoryStore,
  Mind,
  ModelConfig,
  PromptLibrary,
  ProvisionedWorld,
  Recorder,
  RecordingSession,
  RecordingSessionHandle,
  RecordingSummary,
  RecordingTarget,
} from '../core/index.ts';
import { recordingTargetId } from '../core/recording.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createHarnessRuntime } from './orchestrator.ts';
import { createRecordingController } from './recording.ts';

class FakeHandle implements RecordingSessionHandle {
  readonly summaries = new Map<string, RecordingSummary>();
  readonly added: string[] = [];
  readonly lifecycle: string[] = [];
  readonly listeners = new Set<(summary: RecordingSummary) => void>();
  failTarget: string | undefined;

  list(): readonly RecordingSummary[] { return [...this.summaries.values()]; }
  async add(target: RecordingTarget): Promise<RecordingSummary> {
    const id = recordingTargetId(target);
    this.added.push(id);
    if (id === this.failTarget) throw new Error(`camera ${id} failed`);
    const starting: RecordingSummary = {
      id, target, resolution: { width: 1920, height: 1080 }, state: 'starting', startedAt: 100,
    };
    this.summaries.set(id, starting);
    this.emit(starting);
    const recording: RecordingSummary = { ...starting, state: 'recording' };
    this.summaries.set(id, recording);
    this.emit(recording);
    return recording;
  }
  async stop(id?: string): Promise<readonly RecordingSummary[]> {
    this.lifecycle.push(`stop:${id ?? 'all'}`);
    const selected = id === undefined
      ? [...this.summaries.values()].filter((summary) => ['starting', 'recording', 'finishing'].includes(summary.state))
      : [this.summaries.get(id)].filter((summary): summary is RecordingSummary => summary !== undefined);
    return selected.map((summary) => {
      const done: RecordingSummary = {
        ...summary, state: 'done', endedAt: 160, file: `/videos/${summary.id}.mp4`,
      };
      this.summaries.set(done.id, done);
      this.emit(done);
      return done;
    });
  }
  async close(): Promise<void> { this.lifecycle.push('close'); }
  onChange(listener: (summary: RecordingSummary) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(summary: RecordingSummary): void {
    for (const listener of this.listeners) listener(summary);
  }
}

function provisionedWorld(): ProvisionedWorld {
  return {
    instanceId: 'inst-7',
    httpUrl: 'https://api.example/instances/inst-7',
    wsUrl: 'wss://api.example/instances/inst-7/ws',
    kind: 'attached',
    actors: [],
    context: null,
  };
}

describe('recording controller', () => {
  test('requires a world before lazily opening a recorder', async () => {
    const bus = createBus();
    let opened = 0;
    const controller = createRecordingController({
      recorder: () => ({ async open() { opened++; throw new Error('should not open'); } }),
      bus, runId: 'run-1', uiUrl: 'https://ui.example', logDir: '/logs',
      world: () => undefined, agents: () => [],
    });

    await expect(controller.start({
      resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }],
    })).rejects.toThrow('Recording: world is not provisioned');
    expect(opened).toBe(0);
  });

  test('opens one session, expands agents, follows spawns, resolves names, and emits lifecycle events', async () => {
    const bus = createBus();
    const handle = new FakeHandle();
    let session: RecordingSession | undefined;
    let opens = 0;
    const recorder: Recorder = {
      async open(next) { opens++; session = next; return handle; },
    };
    const agents = [{ id: 'alice', entity: 41, displayName: 'Alice fallback' }];
    const controller = createRecordingController({
      recorder: () => recorder,
      bus,
      runId: 'run-1',
      uiUrl: 'https://ui.example',
      logDir: '/logs',
      now: () => 200,
      world: provisionedWorld,
      agents: () => agents,
      fetch: (async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ entities: [{ id: 41, kind: 'player', name: 'Alice Live' }] });
      }) as typeof fetch,
    });

    const started = await controller.start({
      resolution: { width: 1920, height: 1080 },
      targets: [{ kind: 'overview', orbit: true }, { kind: 'agent', agentId: 'alice' }],
      followNewAgents: true,
      keepWebm: true,
    });

    expect(opens).toBe(1);
    expect(session).toMatchObject({
      runId: 'run-1', instanceId: 'inst-7', uiUrl: 'https://ui.example',
      serverUrl: 'https://api.example', outDir: join('/logs', 'recordings', 'run-1'),
      resolution: { width: 1920, height: 1080 }, keepWebm: true,
    });
    expect(await session!.entityName('alice')).toBe('Alice Live');
    await expect(session!.entityName('missing')).rejects.toThrow("Recording: unknown agent 'missing'");
    expect(started.map((summary) => summary.id)).toEqual(['overview', 'agent-alice']);
    expect(handle.added).toEqual(['overview', 'agent-alice']);

    agents.push({ id: 'bob', entity: 42, displayName: 'Bob' });
    await controller.onAgentSpawned('bob');
    expect(handle.added).toEqual(['overview', 'agent-alice', 'agent-bob']);
    expect(controller.list().map((summary) => summary.id)).toEqual(['overview', 'agent-alice', 'agent-bob']);

    await expect(controller.start({
      resolution: { width: 2560, height: 1440 }, targets: [{ kind: 'overview' }],
    })).rejects.toThrow(
      'Recording: a 1920x1080 session is active; stop it before recording at 2560x1440',
    );

    expect(bus.history({ prefix: 'recording.started' })).toHaveLength(3);
    const stopped = await controller.stop();
    expect(stopped).toHaveLength(3);
    expect(handle.lifecycle).toEqual(['stop:all', 'close']);
    expect(bus.history({ prefix: 'recording.finished' })).toHaveLength(3);
    expect(controller.list().every((summary) => summary.state === 'done')).toBe(true);
  });

  test('falls back to the configured display name and synthesizes rejected camera summaries', async () => {
    const bus = createBus();
    const handle = new FakeHandle();
    handle.failTarget = 'agent-alice';
    let session: RecordingSession | undefined;
    const controller = createRecordingController({
      recorder: () => ({ async open(next) { session = next; return handle; } }),
      bus, runId: 'run-2', uiUrl: 'https://ui.example', logDir: '/logs', now: () => 500,
      world: provisionedWorld,
      agents: () => [{ id: 'alice', entity: 41, displayName: 'Alice fallback' }],
      fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    });

    const results = await controller.start({
      resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'agent', agentId: 'alice' }],
    });

    expect(await session!.entityName('alice')).toBe('Alice fallback');
    expect(results).toEqual([expect.objectContaining({
      id: 'agent-alice', state: 'failed', startedAt: 500, endedAt: 500,
      error: 'camera agent-alice failed',
    })]);
    expect(controller.list()).toEqual(results);
    expect(bus.history({ prefix: 'recording.finished' })).toHaveLength(1);
    expect(bus.history({ prefix: 'log' }).some((event) =>
      event.type === 'log' && event.data.level === 'warn' && event.data.scope === 'recording')).toBe(true);
  });

  test('automatic stop and close are idempotent and preserve final summaries', async () => {
    const bus = createBus();
    const handle = new FakeHandle();
    const controller = createRecordingController({
      recorder: () => ({ async open() { return handle; } }),
      bus, runId: 'run-3', uiUrl: 'https://ui.example', logDir: '/logs',
      world: provisionedWorld, agents: () => [],
    });
    await controller.start({
      resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }], maxSeconds: 0.01,
    });
    const deadline = Date.now() + 1_000;
    while (handle.lifecycle.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(handle.lifecycle).toEqual(['stop:all', 'close']);
    expect(controller.list()[0]?.state).toBe('done');

    await controller.close();
    await controller.close();
    expect(handle.lifecycle).toEqual(['stop:all', 'close']);
  });
});

class FakeRuntimeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeRuntimeWebSocket.CONNECTING;

  constructor(_url: string | URL, _protocols?: string | string[]) {
    super();
    queueMicrotask(() => {
      this.readyState = FakeRuntimeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== 'string') return;
    const command = JSON.parse(data) as { id?: string; type?: string; data?: { token?: string } };
    if (command.id === undefined) return;
    const entity = command.data?.token === 'actor-token-2' ? 2 : 1;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        id: command.id, ok: true, tick: 1,
        ...(command.type === 'claim' ? { role: 'actor', entity } : {}),
      }),
    })));
  }

  close(): void {
    this.readyState = FakeRuntimeWebSocket.CLOSED;
    const event = new Event('close');
    Object.defineProperties(event, { code: { value: 1000 }, reason: { value: 'closed' } });
    queueMicrotask(() => this.dispatchEvent(event));
  }
}

describe('runtime recording integration', () => {
  test('auto-starts after provisioning, follows later spawns, and closes before agents', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalFetch = globalThis.fetch;
    globalThis.WebSocket = FakeRuntimeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/defs/names')) return Response.json({ items: {}, npcs: {} });
      if (path.endsWith('/entities')) {
        return Response.json({ entities: [
          { id: 1, kind: 'player', name: 'Alice', at: { x: 0, z: 0, level: 0 }, hp: { current: 10, max: 10 } },
          { id: 2, kind: 'player', name: 'Bob', at: { x: 1, z: 0, level: 0 }, hp: { current: 10, max: 10 } },
        ] });
      }
      if (path.endsWith('/ground-items')) return Response.json({ items: [] });
      if (path.endsWith('/nodes')) return Response.json({ nodes: [] });
      if (path.endsWith('/stations')) return Response.json({ stations: [] });
      if (path.endsWith('/heat-sources')) return Response.json({ heatSources: [] });
      if (path.endsWith('/inventory') || path.endsWith('/equipment')) return Response.json({ slots: [] });
      if (path.endsWith('/skills')) return Response.json({ skills: {} });
      if (path.endsWith('/prayer')) return Response.json({ points: 0, maxPoints: 0, active: [] });
      if (path.endsWith('/objectives')) return Response.json({ objectives: [] });
      return Response.json({ tick: 1 });
    }) as unknown as typeof fetch;

    const logDir = await mkdtemp(join(tmpdir(), 'harness-recording-runtime-'));
    const bus = createBus();
    const handle = new FakeHandle();
    const recorder: Recorder = { async open() { return handle; } };
    const actor = (id: number) => ({
      instanceId: 'inst-runtime', httpUrl: 'https://api.example/instances/inst-runtime',
      wsUrl: 'wss://api.example/instances/inst-runtime/stream', tag: id === 1 ? 'alice' : 'bob',
      entity: id, token: `actor-token-${id}`,
    });
    const mcp: McpSession = {
      url: 'https://api.example/mcp',
      async connect() {}, tools: () => [], async call() { return null; },
      async provision() {
        return {
          instanceId: 'inst-runtime', httpUrl: 'https://api.example/instances/inst-runtime',
          wsUrl: 'wss://api.example/instances/inst-runtime/stream', kind: 'resumed',
          actors: [actor(1)], context: null,
        };
      },
      async addPlayer() { return actor(2); },
      async close() {},
    };
    const modelConfig: ModelConfig = {
      providers: { mock: { kind: 'mock' } },
      roles: Object.fromEntries(['director', 'admin', 'coordinator', 'agent', 'summarizer'].map((role) =>
        [role, { provider: 'mock', model: 'mock' }])) as unknown as ModelConfig['roles'],
    };
    const models = createModelRegistry(modelConfig, { bus });
    const prompts: PromptLibrary = {
      get: () => '', render: () => '', list: () => [],
    };
    const memory = (agentId: string): MemoryStore => ({
      agentId,
      async remember(input) { return { id: 1, agentId, ...input, tags: input.tags ?? [], importance: input.importance ?? 0, runId: 'run-runtime', createdAt: 0, recallCount: 0 }; },
      async recall() { return []; }, async forget() { return false; }, async update() { return undefined; },
      async recent() { return []; }, async count() { return 0; }, close() { handle.lifecycle.push(`agent:${agentId}:close`); },
    });
    const mind = (agentId: string): Mind => ({
      async wake() {}, async setGoal() {}, async say() {},
      status: () => ({ turns: 0, promptTokensEstimate: 0, historyMessages: 0, compactions: 0, busy: false, lastReasons: [] }),
      transcript: () => [],
      async dispose() { handle.lifecycle.push(`agent:${agentId}:dispose`); },
    });
    const runtime = createHarnessRuntime({
      runId: 'run-runtime', mcpUrl: mcp.url, uiUrl: 'https://ui.example',
      world: { kind: 'resume', worldId: 'world-runtime' },
      agents: [{ id: 'alice', displayName: 'Alice' }], headless: false, logDir, dataDir: logDir,
      recording: {
        resolution: { width: 1920, height: 1080 },
        targets: [{ kind: 'overview' }], followNewAgents: true,
      },
    }, {
      bus, models, prompts, memoryFactory: { open: memory }, mindFactory: (deps) => mind(deps.agentId), mcp, recorder,
    });

    try {
      await runtime.start();
      expect(handle.added).toEqual(['overview', 'agent-alice']);
      await runtime.commands.spawnAgent({ id: 'bob', displayName: 'Bob' });
      expect(handle.added).toEqual(['overview', 'agent-alice', 'agent-bob']);
      expect(bus.history({ prefix: 'recording.started' })).toHaveLength(3);

      await runtime.commands.stop('test complete');
      expect(handle.lifecycle.slice(0, 2)).toEqual(['stop:all', 'close']);
      expect(handle.lifecycle.indexOf('close')).toBeLessThan(handle.lifecycle.indexOf('agent:alice:dispose'));
      expect(bus.history({ prefix: 'recording.finished' })).toHaveLength(3);
    } finally {
      await runtime.commands.stop('test cleanup');
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test('reports automatic recorder startup failure without aborting the run', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'harness-recording-failure-'));
    const bus = createBus();
    const mcp: McpSession = {
      url: 'https://api.example/mcp',
      async connect() {}, tools: () => [], async call() { return null; },
      async provision() { return provisionedWorld(); },
      async addPlayer() { throw new Error('not used'); }, async close() {},
    };
    const modelConfig: ModelConfig = {
      providers: { mock: { kind: 'mock' } },
      roles: Object.fromEntries(['director', 'admin', 'coordinator', 'agent', 'summarizer'].map((role) =>
        [role, { provider: 'mock', model: 'mock' }])) as unknown as ModelConfig['roles'],
    };
    const runtime = createHarnessRuntime({
      runId: 'run-record-failure', mcpUrl: mcp.url, uiUrl: 'https://ui.example',
      world: { kind: 'resume', worldId: 'world-runtime' }, agents: [], headless: false,
      logDir, dataDir: logDir,
      recording: { resolution: { width: 1920, height: 1080 }, targets: [{ kind: 'overview' }] },
    }, {
      bus,
      models: createModelRegistry(modelConfig, { bus }),
      prompts: { get: () => '', render: () => '', list: () => [] },
      memoryFactory: { open() { throw new Error('not used'); } },
      mindFactory() { throw new Error('not used'); },
      mcp,
      recorder: { async open() { throw new Error('Chromium unavailable'); } },
    });

    try {
      await runtime.start();
      expect(bus.history().some((event) => event.type === 'log'
        && event.data.scope === 'recording'
        && event.data.level === 'error'
        && event.data.message.includes('Chromium unavailable'))).toBe(true);
      expect(bus.history({ prefix: 'run.error' })).toHaveLength(0);
    } finally {
      await runtime.commands.stop('test complete');
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
