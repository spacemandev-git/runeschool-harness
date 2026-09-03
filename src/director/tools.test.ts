import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { AgentSpec, RuntimeCommands, RuntimeView } from '../core/index.ts';
import { createMailboxes } from '../runtime/mailbox.ts';
import { createHarnessTools, validateAgentSpec } from './tools.ts';

function view(privateGoal = false, instance?: RuntimeView['instance']): RuntimeView {
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
    usage: () => [], config: () => ({})
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
    expect(tools).toHaveLength(13);
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
    expect(tools).toHaveLength(13);
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
});
