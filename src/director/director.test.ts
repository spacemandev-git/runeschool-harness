import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import type { ModelConfig, RuntimeCommands, RuntimeView } from '../core/index.ts';
import { assistantText, assistantToolCall, createMockProvider, createModelRegistry } from '../models/index.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createMailboxes } from '../runtime/mailbox.ts';
import { createDirector } from './director.ts';
import { createHarnessTools, createMcpPassthroughTools, validateAgentSpec } from './tools.ts';

function registry(bus: ReturnType<typeof createBus>, provider = createMockProvider()) {
  const spec = { provider: 'mock', model: 'mock-model' };
  const config: ModelConfig = { providers: { mock: { kind: 'mock' } }, roles: { director: spec, coordinator: spec, agent: spec, summarizer: spec, admin: spec } };
  return { models: createModelRegistry(config, { bus, providers: { mock: provider } }), provider };
}
function view(): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0, agents: () => [], teams: () => [],
    agentSnapshot: () => undefined, agentReflexes: () => undefined, agentTranscript: () => [],
    directorTranscript: () => [], adminTranscript: () => [], coordinatorTranscript: () => [], usage: () => [], config: () => ({ runId: 'run-test' })
  };
}
function commands(): RuntimeCommands {
  return {
    async directorSay() {}, async adminSay() {}, async agentSay() {}, async coordinatorSay() {}, async setAgentGoal() {},
    pauseAgent() {}, resumeAgent() {}, async agentCommand() { return {}; }, async spawnAgent() {}, async stop() {}
  };
}
function mcp() {
  return {
    url: 'http://test/mcp', async connect() {},
    tools: () => [{ name: 'inspect_world', description: 'inspect', inputSchema: { type: 'object' } as JsonValue }],
    async call(name: string) { return { name, text: 'x'.repeat(7_000) }; },
    async provision() { throw new Error('unused'); }, async addPlayer() { throw new Error('unused'); }, async close() {}
  };
}

describe('director tools and loop', () => {
  test('builds MCP passthroughs and validates spawn specs', async () => {
    const tools = createMcpPassthroughTools(mcp());
    expect(tools[0]?.definition).toMatchObject({ name: 'inspect_world', description: 'MCP: inspect', parameters: { type: 'object' } });
    expect(JSON.stringify(await tools[0]!.run({})).length).toBeLessThanOrEqual(6_010);
    expect(validateAgentSpec({ id: 'hero', tag: 'slot', goal: 'win' })).toMatchObject({ id: 'hero', tag: 'slot', goal: 'win' });
    expect(() => validateAgentSpec({ id: 'Bad' })).toThrow('must match');
  });

  test('spawn_agent and assign_goal reach runtime commands', async () => {
    const bus = createBus(); const spawned: string[] = []; const goals: string[] = [];
    const mailboxes = createMailboxes(bus);
    const runtimeView = { ...view(), agents: () => [{ id: 'hero', displayName: 'Hero', tag: 'hero', entity: 1, state: 'idle' as const, model: 'm', activity: 'idle', turns: 0 }] };
    const runtimeCommands = { ...commands(), async spawnAgent(spec: { id: string }) { spawned.push(spec.id); }, async setAgentGoal(agent: string, goal: string) { goals.push(`${agent}:${goal}`); } } as RuntimeCommands;
    const tools = createHarnessTools({ view: runtimeView, commands: runtimeCommands, async createTeam() {}, watchUrl: () => undefined }, bus, mailboxes);
    await tools.find((tool) => tool.definition.name === 'spawn_agent')!.run({ spec: { id: 'scout' } });
    await tools.find((tool) => tool.definition.name === 'assign_goal')!.run({ agent: 'hero', goal: 'walk' });
    expect(tools).toHaveLength(12);
    expect(await tools.find((tool) => tool.definition.name === 'ask_admin')!.run({ text: 'spawn goblins' })).toEqual({
      ok: true, note: 'the admin replies to your mailbox'
    });
    expect(mailboxes.pending('admin')).toBe(1);
    expect(mailboxes.drain('admin')).toEqual([expect.objectContaining({ from: 'director', text: 'spawn goblins' })]);
    expect(spawned).toEqual(['scout']); expect(goals).toEqual(['hero:walk']);
  });

  test('autoWake consumes inbound messages and tool calls are capped at 30', async () => {
    const bus = createBus(); const mock = createMockProvider();
    mock.respondWith(() => true, assistantToolCall('list_agents', {}));
    const { models } = registry(bus, mock); const boxes = createMailboxes(bus);
    const director = createDirector({
      runtime: { view: view(), commands: commands(), async createTeam() {}, watchUrl: () => undefined },
      mcp: mcp(), models, prompts: createPromptLibrary(), bus,
      config: { runId: 'run-test', mcpUrl: '', uiUrl: '', world: { kind: 'resume', worldId: 'w' }, agents: [], headless: true, logDir: '', dataDir: '' },
      mailboxes: boxes, autoWake: true
    });
    boxes.send('operator', 'director', 'status'); director.notify();
    for (let index = 0; index < 100 && bus.history({ prefix: 'director.tool' }).length < 30; index++) await Bun.sleep(1);
    expect(bus.history({ prefix: 'director.tool' })).toHaveLength(30);
    expect(mock.requests[0]?.messages.some((message) => message.role === 'user' && message.content.includes('[from operator] status'))).toBe(true);
    director.dispose();
  });
});
