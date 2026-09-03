import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import type { AdminDeps, AdminInbound } from '../core/admin.ts';
import type { ModelConfig } from '../core/model.ts';
import type { RuntimeView } from '../core/runtime.ts';
import { assistantText, assistantToolCall, createMockProvider, createModelRegistry } from '../models/index.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createAdmin } from './admin.ts';

function view(): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0,
    instance: { id: 'instance-1', httpUrl: 'http://game', watchUrl: 'http://watch', kind: 'sandbox', tick: 15 },
    agents: () => [{
      id: 'hero', displayName: 'Hero', tag: 'hero', entity: 7, state: 'idle', model: 'mock',
      activity: 'idle', turns: 0, at: { x: 10, z: 10, level: 0 }, hp: { current: 10, max: 10 }, goal: 'win'
    }],
    teams: () => [], agentSnapshot: () => undefined, agentReflexes: () => undefined,
    agentTranscript: () => [], directorTranscript: () => [], adminTranscript: () => [],
    coordinatorTranscript: () => [], usage: () => [], config: () => ({ runId: 'run-test', secret: '[redacted]' })
  };
}

function setup(autoWake = false, adminToken?: string) {
  const bus = createBus();
  const provider = createMockProvider();
  const spec = { provider: 'mock', model: 'mock-model' };
  const config: ModelConfig = {
    providers: { mock: { kind: 'mock' } },
    roles: { director: spec, admin: spec, coordinator: spec, agent: spec, summarizer: spec }
  };
  const models = createModelRegistry(config, { bus, providers: { mock: provider } });
  const inbound: AdminInbound[] = [];
  const reports: string[] = [];
  const deps: AdminDeps = {
    world: {
      instanceId: 'instance-1', httpUrl: 'http://game', wsUrl: 'ws://game', kind: 'sandbox', actors: [], context: {},
      ...(adminToken === undefined ? {} : { adminToken })
    },
    mcp: {
      url: 'http://mcp', async connect() {}, tools: () => [], async call() { return {}; },
      async provision() { throw new Error('unused'); }, async addPlayer() { throw new Error('unused'); }, async close() {}
    },
    defs: { async names() { return { items: {}, npcs: {}, locs: {} }; }, async region(): Promise<JsonValue> { return {}; } },
    view: view(), models, prompts: createPromptLibrary(), bus,
    drainInbound: () => inbound.splice(0), reportToDirector: (text) => { reports.push(text); }, autoWake
  };
  return { admin: createAdmin(deps), provider, inbound, reports, bus };
}

describe('admin persona', () => {
  test('includes director inbound, reports back, and emits turn/tool/report events', async () => {
    const fixture = setup();
    fixture.inbound.push({ from: 'director', text: 'spawn completed?', at: 1 });
    fixture.provider.enqueue(assistantToolCall('report_to_director', { text: 'Spawned goblins at 11,11,0.' }, 'report-1'));
    fixture.provider.enqueue(assistantText('Spawned goblins at 11,11,0.'));
    await fixture.admin.say('Handle the request.');

    expect(fixture.provider.requests[0]?.messages.some((message) =>
      message.role === 'user' && message.content.includes('[from director] spawn completed?'))).toBe(true);
    expect(fixture.reports).toEqual(['Spawned goblins at 11,11,0.']);
    expect(fixture.bus.history({ prefix: 'admin.report' })).toHaveLength(1);
    expect(fixture.bus.history({ prefix: 'admin.turn' })).toHaveLength(2);
    const toolEvent = fixture.bus.history({ prefix: 'admin.tool' })[0];
    expect(toolEvent?.type).toBe('admin.tool');
    if (toolEvent?.type === 'admin.tool') expect(toolEvent.data).toMatchObject({ ok: true, call: { name: 'report_to_director' } });
    fixture.admin.dispose();
  });

  test('caps a turn at 30 tool calls and emits the warning', async () => {
    const fixture = setup();
    fixture.provider.respondWith(() => true, assistantToolCall('list_agents', {}));
    await fixture.admin.say('loop');
    expect(fixture.bus.history({ prefix: 'admin.tool' })).toHaveLength(30);
    expect(fixture.bus.history({ prefix: 'log' }).some((event) =>
      event.type === 'log' && event.data.message === 'Admin tool-call cap reached')).toBe(true);
    fixture.admin.dispose();
  });

  test('notify buffers inbound but does not turn when autoWake is false', async () => {
    const fixture = setup(false);
    fixture.inbound.push({ from: 'director', text: 'quiet request', at: 1 });
    fixture.admin.notify();
    await Bun.sleep(5);
    expect(fixture.provider.requests).toHaveLength(0);
    fixture.admin.dispose();
  });

  test('never emits the attached-world admin token in turn or report payloads', async () => {
    const secret = 'attached-admin-secret';
    const fixture = setup(false, secret);
    fixture.provider.enqueue(assistantToolCall('report_to_director', { text: `done with ${secret}`, admin_token: secret }));
    fixture.provider.enqueue(assistantText(`reported ${secret}`));
    await fixture.admin.say('report');
    expect(JSON.stringify(fixture.bus.history())).not.toContain(secret);
    expect(fixture.reports).toEqual(['done with [redacted]']);
    fixture.admin.dispose();
  });
});
