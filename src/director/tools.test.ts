import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { AgentSpec, RecordingRequest, RecordingSummary, RuntimeCommands, RuntimeView } from '../core/index.ts';
import { createMailboxes } from '../runtime/mailbox.ts';
import { createHarnessTools, validateAgentSpec } from './tools.ts';

function view(privateGoal = false, instance?: RuntimeView['instance'], recordings: readonly RecordingSummary[] = []): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0,
    ...(instance === undefined ? {} : { instance }),
    agents: () => [{
      id: 'hero', displayName: 'Hero', tag: 'hero', entity: 1, state: 'idle',
      goal: privateGoal ? '(private)' : 'win', ...(privateGoal ? { privateGoal: true } : {}),
      model: 'mock', activity: 'idle', turns: 0
    }],
    teams: () => [], agentSnapshot: () => undefined, agentReflexes: () => ({ rules: [], queue: [] }),
    agentTranscript: () => [{ role: 'user', content: 'secret transcript' }],
    directorTranscript: () => [], adminTranscript: () => [], coordinatorTranscript: () => [],
    usage: () => [], recordings: () => recordings, config: () => ({})
  };
}

function commands(calls: { pauses: unknown[][]; removed: Set<string> }): RuntimeCommands {
  return {
    async directorSay() {}, async adminSay() {}, async agentSay() {}, async coordinatorSay() {},
    async setAgentGoal() {},
    pauseAgent(...args) { calls.pauses.push(args); },
    resumeAgent() {}, async agentCommand() { return {}; }, async spawnAgent() {},
    async removeAgent(agentId) {
      if (calls.removed.has(agentId)) return { removed: false };
      calls.removed.add(agentId); return { removed: true };
    },
    async stop() {}
  };
}

describe('director harness tools', () => {
  test('exposes remove_agent idempotently and forwards blind pause options', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const runtime = { view: view(), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    expect(tools).toHaveLength(16);
    const remove = tools.find((tool) => tool.definition.name === 'remove_agent')!;
    expect(await remove.run({ agent: 'hero', reason: 'eliminated' })).toEqual({ removed: true });
    expect(await remove.run({ agent: 'hero', reason: 'again' })).toEqual({ removed: false });
    await tools.find((tool) => tool.definition.name === 'pause_agent')!.run({ agent: 'hero', blind: true });
    expect(calls.pauses).toEqual([['hero', undefined, { blind: true }]]);
  });

  test('private agent reports contain only the redacted summary', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const runtime = { view: view(true), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    expect(await tools.find((tool) => tool.definition.name === 'agent_report')!.run({ agent: 'hero' })).toEqual({
      summary: expect.objectContaining({ id: 'hero', goal: '(private)', privateGoal: true })
    });
  });

  test('spawn_agent publishes the nested tile schema', () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const runtime = { view: view(), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    expect(tools).toHaveLength(16);
    const spawn = tools.find((tool) => tool.definition.name === 'spawn_agent')!;
    const parameters = spawn.definition.parameters as unknown as {
      properties: { spec: { properties: { spawn: { properties: { at: { required: string[] } } } } } };
    };
    expect(parameters.properties.spec.properties.spawn.properties.at.required).toEqual(['x', 'z', 'level']);
    expect(spawn.definition.description).toContain('currently connected world');
    expect(spawn.definition.description).toContain('tag defaults to id');
    expect(spawn.definition.description).toContain('shared hosted world');
    expect(spawn.definition.description).toContain('result lists ignored fields');
    const spec = parameters.properties.spec.properties as unknown as {
      tag: { description: string };
      spawn: { properties: { at: { description: string } } };
    };
    expect(spec.tag.description).toContain('shared hosted world');
    expect(spec.spawn.properties.at.description).toContain('shared hosted world');
  });

  test('normalises flat spawn tiles and rejects invalid agent specs precisely', () => {
    expect(validateAgentSpec({ id: 'bob', spawn: { x: 3221, z: 3218, level: 0 } })).toEqual({
      id: 'bob', spawn: { at: { x: 3221, z: 3218, level: 0 } }
    });
    expect(() => validateAgentSpec({ id: 'bob', instanceId: 'inst-10' })).toThrow(
      'spec.instanceId is not a recognised field; known fields: id, displayName, tag, team, goal, privateGoal, persona, voice, reflexPreset, spawn, useExistingSlot; the agent joins the connected world; omit instanceId'
    );
    expect(() => validateAgentSpec({ id: 'bob', spawn: { at: { x: 1, z: 2 } } })).toThrow(
      'spec.spawn.at.level must be a number'
    );
  });

  test('spawn_agent forwards the normalised spec to the runtime', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const spawned: AgentSpec[] = [];
    const runtimeCommands = {
      ...commands(calls),
      async spawnAgent(spec: AgentSpec) { spawned.push(spec); }
    } as RuntimeCommands;
    const runtime = { view: view(), commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    await tools.find((tool) => tool.definition.name === 'spawn_agent')!.run({
      spec: { id: 'bob', spawn: { x: 3221, z: 3218, level: 0 } }
    });
    expect(spawned).toEqual([{ id: 'bob', spawn: { at: { x: 3221, z: 3218, level: 0 } } }]);
  });

  test('spawn_agent reports ignored hosted placement and equipment requests', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const hosted = {
      id: 'inst-10', httpUrl: 'https://x/instances/inst-10', kind: 'hosted', tick: 1,
    };
    const runtime = {
      view: view(false, hosted), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined,
    };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    const result = await tools.find((tool) => tool.definition.name === 'spawn_agent')!.run({
      spec: {
        id: 'bob',
        spawn: {
          at: { x: 3221, z: 3218, level: 0 },
          equipment: [{ item: 1277 }],
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      agent: 'bob',
      ignored: ['spawn.at', 'spawn.equipment'],
      note: expect.stringContaining('bank'),
    });
  });

  test('spawn_agent keeps its exact success result in a hosted world without ignored fields', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const hosted = {
      id: 'inst-10', httpUrl: 'https://x/instances/inst-10', kind: 'hosted', tick: 1,
    };
    const runtime = {
      view: view(false, hosted), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined,
    };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));

    expect(await tools.find((tool) => tool.definition.name === 'spawn_agent')!.run({ spec: { id: 'bob' } }))
      .toEqual({ ok: true, agent: 'bob' });
  });

  test('spawn_agent keeps its exact success result for non-hosted spawn requests', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const sandbox = {
      id: 'inst-10', httpUrl: 'https://x/instances/inst-10', kind: 'sandbox', tick: 1,
    };
    const runtime = {
      view: view(false, sandbox), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined,
    };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));

    expect(await tools.find((tool) => tool.definition.name === 'spawn_agent')!.run({
      spec: { id: 'bob', spawn: { equipment: [{ item: 1277 }] } },
    })).toEqual({ ok: true, agent: 'bob' });
  });

  test('unknown agent errors list known agents and direct admin requests to ask_admin', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const runtime = { view: view(), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    await expect(tools.find((tool) => tool.definition.name === 'assign_goal')!.run({
      agent: 'admin', goal: 'help'
    })).rejects.toThrow("Unknown agent 'admin'; known agents: hero; the admin persona is reached with ask_admin");
  });

  test('start_recording applies defaults, expands current agents, and delegates options', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const requests: RecordingRequest[] = [];
    const runtimeCommands = {
      ...commands(calls),
      async startRecording(request: RecordingRequest) { requests.push(request); return []; },
    } satisfies RuntimeCommands;
    const runtime = { view: view(), commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined };
    const start = createHarnessTools(runtime, createBus(), createMailboxes(createBus()))
      .find((tool) => tool.definition.name === 'start_recording')!;

    expect(await start.run({})).toEqual({ ok: true, recordings: [] });
    expect(requests[0]).toEqual({
      resolution: { width: 1920, height: 1080 },
      targets: [{ kind: 'overview', orbit: true }, { kind: 'agent', agentId: 'hero' }],
      followNewAgents: true,
    });

    await start.run({ resolution: '2k', cameras: ['agent:hero'], maxSeconds: 15, keepWebm: true });
    expect(requests[1]).toEqual({
      resolution: { width: 2560, height: 1440 },
      targets: [{ kind: 'agent', agentId: 'hero' }],
      maxSeconds: 15,
      keepWebm: true,
    });
  });

  test('start_recording reports output directory and failed cameras', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const summaries: readonly RecordingSummary[] = [
      {
        id: 'overview', target: { kind: 'overview' }, resolution: { width: 1920, height: 1080 },
        state: 'done', startedAt: 1, endedAt: 2, file: '/runs/test/recordings/run-test/overview.mp4',
      },
      {
        id: 'agent-hero', target: { kind: 'agent', agentId: 'hero' }, resolution: { width: 1920, height: 1080 },
        state: 'failed', startedAt: 1, endedAt: 2, error: 'camera timed out',
      },
    ];
    const runtimeCommands = { ...commands(calls), async startRecording() { return summaries; } } satisfies RuntimeCommands;
    const runtime = { view: view(), commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined };
    const start = createHarnessTools(runtime, createBus(), createMailboxes(createBus()))
      .find((tool) => tool.definition.name === 'start_recording')!;

    expect(await start.run({ cameras: ['overview'] })).toEqual(JSON.parse(JSON.stringify({
      ok: true,
      recordings: summaries,
      outDir: '/runs/test/recordings/run-test',
      note: 'Failed cameras: agent-hero: camera timed out',
    })));
  });

  test('start_recording rejects bad values, unknown agents, and unknown keys', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const runtimeCommands = { ...commands(calls), async startRecording() { return []; } } satisfies RuntimeCommands;
    const runtime = { view: view(), commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined };
    const start = createHarnessTools(runtime, createBus(), createMailboxes(createBus()))
      .find((tool) => tool.definition.name === 'start_recording')!;

    await expect(start.run({ resolution: 'cinema' })).rejects.toThrow("resolution 'cinema' must be one of");
    await expect(start.run({ cameras: ['side'] })).rejects.toThrow("invalid recording target 'side'");
    await expect(start.run({ cameras: ['agent:nobody'] })).rejects.toThrow("Unknown recording agent 'nobody'; known agents: hero");
    await expect(start.run({ maxSeconds: 1.5 })).rejects.toThrow('maxSeconds must be a positive integer');
    await expect(start.run({ extra: true })).rejects.toThrow('start_recording.extra is not a recognised field');
  });

  test('recording tools report missing commands, stop one or all cameras, and list state', async () => {
    const calls = { pauses: [] as unknown[][], removed: new Set<string>() };
    const summary: RecordingSummary = {
      id: 'overview', target: { kind: 'overview' }, resolution: { width: 1920, height: 1080 },
      state: 'done', startedAt: 1, endedAt: 2, file: '/tmp/overview.mp4',
    };
    const unavailable = { view: view(), commands: commands(calls), async createTeam() {}, watchUrl: () => undefined };
    const unavailableStart = createHarnessTools(unavailable, createBus(), createMailboxes(createBus()))
      .find((tool) => tool.definition.name === 'start_recording')!;
    await expect(unavailableStart.run({})).rejects.toThrow('recording is not available in this runtime');

    const stopped: Array<string | undefined> = [];
    const runtimeCommands = {
      ...commands(calls),
      async stopRecording(camera?: string) { stopped.push(camera); return [summary]; },
    } satisfies RuntimeCommands;
    const runtime = { view: view(false, undefined, [summary]), commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined };
    const tools = createHarnessTools(runtime, createBus(), createMailboxes(createBus()));
    const stop = tools.find((tool) => tool.definition.name === 'stop_recording')!;
    const list = tools.find((tool) => tool.definition.name === 'list_recordings')!;

    expect(await stop.run({ camera: 'overview' })).toEqual(JSON.parse(JSON.stringify({ ok: true, recordings: [summary] })));
    expect(await stop.run({})).toEqual(JSON.parse(JSON.stringify({ ok: true, recordings: [summary] })));
    expect(stopped).toEqual(['overview', undefined]);
    expect(await list.run({})).toEqual(JSON.parse(JSON.stringify({ recordings: [summary] })));
    await expect(stop.run({ typo: true })).rejects.toThrow('stop_recording.typo is not a recognised field');
    await expect(list.run({ typo: true })).rejects.toThrow('list_recordings.typo is not a recognised field');
  });
});
