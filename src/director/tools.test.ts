import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { RuntimeCommands, RuntimeView } from '../core/index.ts';
import { createMailboxes } from '../runtime/mailbox.ts';
import { createHarnessTools } from './tools.ts';

function view(privateGoal = false): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0,
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
});
