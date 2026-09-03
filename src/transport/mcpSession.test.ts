import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import {
  createMcpSession,
  rebaseJoinUrls,
  SandboxNeedsPlayers,
  SpawnRequired
} from './mcpSession.ts';

const JOIN = {
  instanceId: 'inst-1',
  httpUrl: 'http://game/instances/inst-1',
  wsUrl: 'ws://game/instances/inst-1/stream',
  actors: [{ tag: 'hero', entity: 1, token: 'actor-secret' }]
} as const;

const LOOPBACK_JOIN = {
  instanceId: 'inst-loopback',
  httpUrl: 'http://127.0.0.1:7800/instances/i',
  wsUrl: 'ws://127.0.0.1:7800/instances/i/stream?since=0',
  actors: [{ tag: 'hero', entity: 1, token: 'actor-secret' }]
} as const;

describe('rebaseJoinUrls', () => {
  test('rebases loopback HTTP, WebSocket, and actor URLs onto a remote MCP origin', () => {
    const join = {
      ...LOOPBACK_JOIN,
      actors: LOOPBACK_JOIN.actors.map((actor) => ({
        ...actor,
        instanceId: LOOPBACK_JOIN.instanceId,
        httpUrl: LOOPBACK_JOIN.httpUrl,
        wsUrl: LOOPBACK_JOIN.wsUrl
      }))
    };

    expect(rebaseJoinUrls(join, 'https://api.runeschool.dev/mcp')).toEqual({
      rebased: true,
      join: {
        ...join,
        httpUrl: 'https://api.runeschool.dev/instances/i',
        wsUrl: 'wss://api.runeschool.dev/instances/i/stream?since=0',
        actors: join.actors.map((actor) => ({
          ...actor,
          httpUrl: 'https://api.runeschool.dev/instances/i',
          wsUrl: 'wss://api.runeschool.dev/instances/i/stream?since=0'
        }))
      }
    });
  });

  test('leaves non-loopback join URLs alone', () => {
    const join = {
      ...JOIN,
      actors: JOIN.actors.map((actor) => ({
        ...actor,
        instanceId: JOIN.instanceId,
        httpUrl: JOIN.httpUrl,
        wsUrl: JOIN.wsUrl
      }))
    };
    const result = rebaseJoinUrls(join, 'https://api.runeschool.dev/mcp');
    expect(result).toEqual({ join, rebased: false });
    expect(result.join).toBe(join);
  });

  test('leaves all join URLs alone when the MCP URL is loopback', () => {
    const join = {
      ...LOOPBACK_JOIN,
      actors: LOOPBACK_JOIN.actors.map((actor) => ({
        ...actor,
        instanceId: LOOPBACK_JOIN.instanceId,
        httpUrl: LOOPBACK_JOIN.httpUrl,
        wsUrl: LOOPBACK_JOIN.wsUrl
      }))
    };
    const result = rebaseJoinUrls(join, 'http://localhost:3000/mcp');
    expect(result).toEqual({ join, rebased: false });
    expect(result.join).toBe(join);
  });
});

describe('createMcpSession provisioning', () => {
  test('rebases scenario join info from a remote MCP endpoint and warns exactly once', async () => {
    const bus = createBus();
    const session = createMcpSession('https://api.runeschool.dev/mcp', bus, {
      call: async () => ({ scenario: 'saved-one', joinInfo: LOOPBACK_JOIN })
    });

    const world = await session.provision({ kind: 'scenario', name: 'saved-one', seed: 1 }, []);
    expect(world.httpUrl).toBe('https://api.runeschool.dev/instances/i');
    expect(world.wsUrl).toBe('wss://api.runeschool.dev/instances/i/stream?since=0');
    expect(world.actors).toEqual([{
      instanceId: 'inst-loopback',
      httpUrl: 'https://api.runeschool.dev/instances/i',
      wsUrl: 'wss://api.runeschool.dev/instances/i/stream?since=0',
      tag: 'hero',
      entity: 1,
      token: 'actor-secret'
    }]);
    const warnings = bus.history().filter((event) => event.type === 'log');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toEqual({
      level: 'warn',
      scope: 'mcp',
      message: 'MCP advertised loopback join URLs; rebased onto https://api.runeschool.dev'
    });
  });

  test('does not rebase or warn when the MCP endpoint is loopback', async () => {
    const bus = createBus();
    const session = createMcpSession('http://127.0.0.1:9000/mcp', bus, {
      call: async () => ({ scenario: 'saved-one', joinInfo: LOOPBACK_JOIN })
    });

    const world = await session.provision({ kind: 'scenario', name: 'saved-one', seed: 1 }, []);
    expect(world.httpUrl).toBe(LOOPBACK_JOIN.httpUrl);
    expect(world.wsUrl).toBe(LOOPBACK_JOIN.wsUrl);
    expect(world.actors[0]?.httpUrl).toBe(LOOPBACK_JOIN.httpUrl);
    expect(world.actors[0]?.wsUrl).toBe(LOOPBACK_JOIN.wsUrl);
    expect(bus.history().filter((event) => event.type === 'log')).toHaveLength(0);
  });

  test('redacts credentials from MCP bus arguments, previews, and URLs', async () => {
    const bus = createBus();
    const client = {
      async connect() {},
      async listTools() { return { tools: [] }; },
      async callTool() {
        return {
          content: [{ type: 'text', text: '{"player":{"token":"actor-secret"},"ok":true}' }]
        };
      },
      async close() {}
    } as unknown as Client;
    const session = createMcpSession('http://mcp.test/mcp?apiKey=url-secret', bus, { client });
    await session.connect();
    expect(await session.call('secret_tool', { admin_token: 'argument-secret' })).toEqual({
      player: { token: 'actor-secret' }, ok: true
    });
    const history = JSON.stringify(bus.history());
    expect(history).not.toContain('actor-secret');
    expect(history).not.toContain('argument-secret');
    expect(history).not.toContain('url-secret');
    expect(history).toContain('[REDACTED]');
  });

  test('provisions bundled and saved scenarios with their required call shapes', async () => {
    const calls: Array<{ name: string; args?: Readonly<Record<string, unknown>> }> = [];
    const doc = { actors: [{ tag: 'hero', spawnAt: { x: 4, z: 5, level: 0 } }] };
    const session = createMcpSession('http://mcp', createBus(), {
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'get_example_scenario') return doc;
        return { scenario: 'arena-island', joinInfo: JOIN } as JsonValue;
      }
    });
    const bundled = await session.provision({ kind: 'scenario', name: 'arena-island', seed: 7, pvp: true }, []);
    expect(calls.map((call) => call.name)).toEqual(['get_example_scenario', 'start_scenario']);
    expect(calls[1]?.args).toMatchObject({ doc, seed: 7, realtime: true, pvp: true });
    expect(bundled.defaultSpawn).toEqual({ x: 4, z: 5, level: 0 });
    expect(bundled.context).toEqual(doc);

    calls.length = 0;
    const saved = await session.provision({ kind: 'scenario', name: 'saved-one', seed: 3 }, []);
    expect(calls[0]).toEqual({ name: 'start_scenario', args: { scenario_id: 'saved-one', seed: 3, realtime: true } });
    expect(saved.context).toBe('arena-island');
  });

  test('provisions sandboxes, resumes, and attaches without leaking tokens to the bus', async () => {
    const bus = createBus();
    const calls: string[] = [];
    const session = createMcpSession('http://mcp', bus, {
      call: async (name): Promise<JsonValue> => {
        calls.push(name);
        if (name === 'list_regions') return {
          regions: [{ regionId: 12, spawn: { x: 10, z: 20, level: 0 }, name: 'Test' }]
        };
        if (name === 'resume_world') return { saved: 'w', joinInfo: JOIN };
        return { joinInfo: JOIN };
      }
    });
    const sandbox = await session.provision({ kind: 'sandbox', query: 'test', seed: 1 }, [{ tag: 'hero' }]);
    expect(sandbox.kind).toBe('sandbox');
    expect(sandbox.defaultSpawn).toEqual({ x: 10, z: 20, level: 0 });
    const resumed = await session.provision({ kind: 'resume', worldId: 'w' }, []);
    expect(resumed.context).toEqual({ saved: 'w' });
    const adminToken = 'attached-admin-secret';
    const attached = await session.provision({
      kind: 'attach', instanceId: JOIN.instanceId, httpUrl: JOIN.httpUrl, wsUrl: JOIN.wsUrl,
      actors: sandbox.actors, adminToken
    }, []);
    expect(attached.kind).toBe('attached');
    expect(attached.adminToken).toBe(adminToken);
    expect(calls).toEqual(['list_regions', 'create_sandbox_world', 'resume_world']);
    expect(JSON.stringify(bus.history())).not.toContain('actor-secret');
    expect(JSON.stringify(bus.history().filter((event) => event.type.startsWith('mcp.') || event.type.startsWith('world.')))).not.toContain(adminToken);
  });

  test('reports precise join fields and uses recorded defaults for add_player', async () => {
    const calls: Array<{ name: string; args?: Readonly<Record<string, unknown>> }> = [];
    const session = createMcpSession('http://mcp', createBus(), {
      call: async (name, args): Promise<JsonValue> => {
        calls.push({ name, args });
        if (name === 'list_regions') return { regions: [{ regionId: 1, spawn: { x: 8, z: 9, level: 0 } }] };
        if (name === 'add_player') return {
          player: { tag: 'ally', entity: 2, token: 'ally-token' },
          joinInfo: { ...JOIN, actors: [{ tag: 'ally', entity: 2, token: 'ally-token' }] }
        };
        return { joinInfo: JOIN };
      }
    });
    await session.provision({ kind: 'sandbox', query: 'x', seed: 1 }, [{ tag: 'hero' }]);
    const actor = await session.addPlayer('inst-1', { tag: 'ally' });
    expect(actor.entity).toBe(2);
    expect(calls.at(-1)?.args).toMatchObject({ spawn_at: { x: 8, z: 9, level: 0 } });

    const noDefault = createMcpSession('http://mcp', createBus(), { call: async () => ({}) });
    await expect(noDefault.addPlayer('unknown', { tag: 'x' })).rejects.toBeInstanceOf(SpawnRequired);
    await expect(session.provision({ kind: 'sandbox', query: 'x', seed: 1 }, [])).rejects.toBeInstanceOf(SandboxNeedsPlayers);

    const broken = createMcpSession('http://mcp', createBus(), {
      call: async (): Promise<JsonValue> => ({
        joinInfo: { instanceId: JOIN.instanceId, httpUrl: JOIN.httpUrl, actors: JOIN.actors }
      })
    });
    await expect(broken.provision({ kind: 'resume', worldId: 'x' }, [])).rejects.toThrow("joinInfo.wsUrl");
  });
});
