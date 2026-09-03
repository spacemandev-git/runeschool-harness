import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import type { AdminDeps } from '../core/admin.ts';
import type { McpSession } from '../core/transport.ts';
import type { RuntimeView } from '../core/runtime.ts';
import { createAdminTools } from './tools.ts';

interface RecordedCall { readonly name: string; readonly args: Readonly<Record<string, unknown>>; }

function view(): RuntimeView {
  return {
    runId: 'run-test', startedAt: 0,
    instance: { id: 'instance-1', httpUrl: 'http://game', kind: 'sandbox', tick: 12 },
    agents: () => [
      { id: 'hero', displayName: 'Hero', tag: 'hero', entity: 7, state: 'idle', model: 'm', activity: 'idle', turns: 0, at: { x: 10, z: 10, level: 0 }, hp: { current: 10, max: 10 } },
      { id: 'scout', displayName: 'Scout', tag: 'sc', entity: 9, state: 'idle', model: 'm', activity: 'idle', turns: 0, at: { x: 20, z: 20, level: 0 } }
    ],
    teams: () => [], agentSnapshot: () => undefined, agentReflexes: () => undefined,
    agentTranscript: () => [], directorTranscript: () => [], adminTranscript: () => [],
    coordinatorTranscript: () => [], usage: () => [], config: () => ({ runId: 'run-test' })
  };
}

function setup(options: { readonly token?: string; readonly onCall?: (call: RecordedCall, index: number) => JsonValue | Promise<JsonValue> } = {}) {
  const calls: RecordedCall[] = [];
  const mcp: McpSession = {
    url: 'http://mcp', async connect() {},
    tools: () => [{
      name: 'place', description: 'place things',
      inputSchema: { type: 'object', properties: { instance_id: { type: 'string' }, placements: {}, admin_token: { type: 'string' } } }
    }],
    async call(name, args = {}) {
      const call = { name, args }; calls.push(call);
      if (options.onCall !== undefined) return options.onCall(call, calls.length - 1);
      return { ok: true };
    },
    async provision() { throw new Error('unused'); }, async addPlayer() { throw new Error('unused'); }, async close() {}
  };
  const world = {
    instanceId: 'instance-1', httpUrl: 'http://game', wsUrl: 'ws://game', kind: 'sandbox' as const,
    actors: [], context: {}, ...(options.token === undefined ? {} : { adminToken: options.token })
  };
  const deps = {
    world, mcp,
    defs: { async names() { return {
      npcs: { '100': 'Goblin', '101': 'Goblin guard', '102': 'Goblin' },
      items: { '1205': 'Bronze sword', '1206': 'Bronze sword (p)' }, locs: { '1276': 'Tree' }
    }; }, async region() { return {}; } },
    view: view(), bus: createBus(), reportToDirector() {}, drainInbound: () => [], autoWake: false,
    models: undefined, prompts: undefined
  } as unknown as AdminDeps;
  const tools = createAdminTools(deps);
  const tool = (name: string) => tools.find((entry) => entry.definition.name === name)!;
  return { calls, tool, bus: deps.bus };
}

describe('admin tools', () => {
  test('spawn_npcs resolves names, skips rejected tiles, and never uses the agent tile', async () => {
    const fixture = setup({ onCall: (_call, index) => {
      if (index === 0) throw new Error('unwalkable-placement: blocked');
      return { placements: [{ id: `pl-${index}`, entity: 40 + index }] };
    } });
    const result = await fixture.tool('spawn_npcs').run({ npc: 'Goblin', count: 3, near_agent: 'hero', radius: 2 }) as Record<string, unknown>;
    expect(fixture.calls).toHaveLength(4);
    const tiles = fixture.calls.map((call) => ((call.args.placements as Record<string, unknown>).at));
    expect(new Set(tiles.map((at) => JSON.stringify(at))).size).toBe(4);
    expect(tiles).not.toContainEqual({ x: 10, z: 10, level: 0 });
    expect((result.placed as unknown[])).toHaveLength(3);
    expect(result.skipped).toEqual([{ at: { x: 11, z: 11, level: 0 }, error: 'unwalkable-placement: blocked' }]);
  });

  test('exact-name duplicates resolve to the lowest config id and list the alternatives', async () => {
    const fixture = setup({ onCall: (_call, index) => ({ placements: [{ id: `pl-${index}`, entity: 50 + index }] }) });
    const result = await fixture.tool('spawn_npcs').run({ npc: 'goblin', at: { x: 20, z: 20, level: 0 } }) as Record<string, unknown>;
    expect(result.npc).toEqual({ id: 100, name: 'Goblin', alternatives: [102] });
    expect((fixture.calls[0]?.args.placements as Record<string, unknown>).npc).toBe(100);
  });

  test('give_items mutates the resolved run-agent entity', async () => {
    const fixture = setup();
    await fixture.tool('give_items').run({ agent: 'hero', item: 'Bronze sword', amount: 2 });
    expect(fixture.calls).toEqual([{
      name: 'mutate_entity',
      args: { instance_id: 'instance-1', entity: 7, mutations: [{ kind: 'give_item', item: 1205, amount: 2 }] }
    }]);
  });

  test('injects and redacts an attach admin token, and omits it otherwise', async () => {
    const secret = 'super-secret-admin';
    const secured = setup({ token: secret, onCall: (call) => ({
      echoed: JSON.parse(JSON.stringify(call.args)) as JsonValue, message: `used ${secret}`
    }) });
    const result = await secured.tool('give_items').run({ agent: 'hero', item: 1205 });
    expect(secured.calls[0]?.args.admin_token).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(secured.bus.history())).not.toContain(secret);

    const open = setup();
    await open.tool('give_items').run({ agent: 'hero', item: 1205 });
    expect(open.calls[0]?.args).not.toHaveProperty('admin_token');
  });

  test('refuses agent despawn and returns ambiguous candidates without MCP', async () => {
    const fixture = setup();
    expect(await fixture.tool('despawn').run({ entity: 7 })).toEqual({ error: 'entity belongs to run agent hero' });
    const ambiguous = await fixture.tool('give_items').run({ agent: 'hero', item: 'Bronze', amount: 1 });
    expect(ambiguous).toEqual({
      error: 'ambiguous item',
      candidates: [{ id: 1205, name: 'Bronze sword' }, { id: 1206, name: 'Bronze sword (p)' }]
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test('mcp_place passthrough injects this run instance id', async () => {
    const fixture = setup();
    await fixture.tool('mcp_place').run({ placements: { kind: 'loc' } });
    expect(fixture.calls[0]).toEqual({
      name: 'place', args: { placements: { kind: 'loc' }, instance_id: 'instance-1' }
    });
  });
});
