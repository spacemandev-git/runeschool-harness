import { describe, expect, test } from 'bun:test';
import type {
  ActorCredentials,
  AddPlayerRequest,
  AgentIdentity,
  AgentIdentityStore,
  HostedWorldClient,
  HostedWorldStatus,
  McpSession,
  ProvisionedWorld,
} from '../core/index.ts';
import { provisionHostedWorld, resolveAgentCredentials } from './credentials.ts';

const existing: ActorCredentials = {
  instanceId: 'inst-1',
  httpUrl: 'https://game.example/instances/inst-1',
  wsUrl: 'wss://game.example/instances/inst-1/stream',
  tag: 'slot-one',
  entity: 1,
  token: 'existing-token',
};

const joined: ActorCredentials = {
  ...existing,
  tag: `wallet-${'a'.repeat(32)}`,
  entity: 7,
  token: 'joined-token',
};

function world(actors: readonly ActorCredentials[] = [existing]): ProvisionedWorld {
  return {
    instanceId: 'inst-1',
    httpUrl: existing.httpUrl,
    wsUrl: existing.wsUrl,
    kind: 'attached',
    actors,
    context: {},
  };
}

function mcp(addPlayer: (instanceId: string, request: AddPlayerRequest) => Promise<ActorCredentials>): McpSession {
  return {
    url: 'https://game.example/mcp',
    async connect() {},
    tools: () => [],
    async call() { return null; },
    async provision() { throw new Error('not used'); },
    addPlayer,
    async close() {},
  };
}

function hostedClient(status?: HostedWorldStatus): HostedWorldClient {
  return {
    backendUrl: 'https://game.example',
    async status() { return status; },
    async join() { return joined; },
  };
}

const identity: AgentIdentity = {
  publicKey: 'public-key',
  async sign() { return new Uint8Array(64); },
};

describe('resolveAgentCredentials', () => {
  test('ensures and joins a hosted identity, warning once when tag or spawn is supplied', async () => {
    const ensured: string[] = [];
    const joinCalls: Array<{ identity: AgentIdentity; options?: { readonly displayName?: string } }> = [];
    const warnings: string[] = [];
    const identities: AgentIdentityStore = {
      async ensure(agentId) { ensured.push(agentId); return identity; },
    };
    const hostedWorld: HostedWorldClient = {
      backendUrl: 'https://game.example',
      async status() { return { instanceId: 'inst-1', status: 'ready', pvp: false }; },
      async join(value, options) { joinCalls.push({ identity: value, options }); return joined; },
    };

    const result = await resolveAgentCredentials({
      selection: { kind: 'hosted', backendUrl: 'https://game.example' },
      spec: { id: 'bob', displayName: 'Bob', tag: 'requested', spawn: { at: { x: 1, z: 2, level: 0 } } },
      world: world([]),
      mcp: mcp(async () => { throw new Error('add_player must not be called'); }),
      hostedWorld,
      identities,
      warn(message) { warnings.push(message); },
    });

    expect(result).toBe(joined);
    expect(ensured).toEqual(['bob']);
    expect(joinCalls).toEqual([{ identity, options: { displayName: 'Bob' } }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ignored because the server assigns the tag and spawn');
  });

  test('uses the agent id as hosted display name and does not warn without tag or spawn', async () => {
    const joinOptions: unknown[] = [];
    const warnings: string[] = [];
    const result = await resolveAgentCredentials({
      selection: { kind: 'hosted', backendUrl: 'https://game.example' },
      spec: { id: 'bob' },
      world: world([]),
      mcp: mcp(async () => { throw new Error('add_player must not be called'); }),
      hostedWorld: {
        ...hostedClient(),
        async join(_value, options) { joinOptions.push(options); return joined; },
      },
      identities: { async ensure(agentId) { expect(agentId).toBe('bob'); return identity; } },
      warn(message) { warnings.push(message); },
    });

    expect(result).toBe(joined);
    expect(joinOptions).toEqual([{ displayName: 'bob' }]);
    expect(warnings).toEqual([]);
  });

  test('keeps scenario, sandbox, and attach credential behavior unchanged', async () => {
    const addCalls: Array<{ instanceId: string; request: AddPlayerRequest }> = [];
    const added = { ...existing, tag: 'newcomer', entity: 2, token: 'new-token' };
    const session = mcp(async (instanceId, request) => {
      addCalls.push({ instanceId, request });
      return added;
    });
    const warn = () => {};

    const scenario = await resolveAgentCredentials({
      selection: { kind: 'scenario', name: 'arena', seed: 1 },
      spec: { id: 'hero', useExistingSlot: true },
      world: world(),
      mcp: session,
      warn,
    });
    expect(scenario).toBe(existing);

    const sandbox = await resolveAgentCredentials({
      selection: { kind: 'sandbox', query: 'field', seed: 1 },
      spec: { id: 'hero', tag: 'slot-one' },
      world: world(),
      mcp: session,
      warn,
    });
    expect(sandbox).toBe(existing);

    const attached = await resolveAgentCredentials({
      selection: { kind: 'attach', instanceId: 'inst-1', httpUrl: existing.httpUrl, wsUrl: existing.wsUrl, actors: [] },
      spec: { id: 'newcomer', displayName: 'Newcomer', spawn: { at: { x: 3, z: 4, level: 0 } } },
      world: world([]),
      mcp: session,
      warn,
    });
    expect(attached).toBe(added);
    expect(addCalls).toEqual([{
      instanceId: 'inst-1',
      request: {
        tag: 'newcomer',
        displayName: 'Newcomer',
        spawnAt: { x: 3, z: 4, level: 0 },
      },
    }]);
  });
});

describe('provisionHostedWorld', () => {
  test('turns ready hosted status into a provisioned world with a secure WebSocket URL', async () => {
    const status = { instanceId: 'inst-10', status: 'ready', name: 'Shared world', pvp: true, participantCount: 4 };
    await expect(provisionHostedWorld(hostedClient(status), 'https://game.example/api/')).resolves.toEqual({
      instanceId: 'inst-10',
      httpUrl: 'https://game.example/api/instances/inst-10',
      wsUrl: 'wss://game.example/api/instances/inst-10/stream',
      kind: 'hosted',
      actors: [],
      context: status,
    });
  });

  test('rejects missing and not-ready hosted worlds with clear status errors', async () => {
    await expect(provisionHostedWorld(hostedClient(), 'https://game.example')).rejects.toThrow(
      'No shared hosted world is available',
    );
    await expect(provisionHostedWorld(hostedClient({ instanceId: 'inst-10', status: 'starting', pvp: false }), 'https://game.example'))
      .rejects.toThrow('status: starting');
  });
});
