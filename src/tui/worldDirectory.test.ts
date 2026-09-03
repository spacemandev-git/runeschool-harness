import { describe, expect, test } from 'bun:test';
import { createRuneSchoolWorldDirectory } from './worldDirectory.ts';

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

describe('RuneSchool world directory', () => {
  test('lists, connects, and spawns through the configured backend', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('/instances') && method === 'GET') {
        return json([{ id: 'inst-1', tick: 12, state: 'running', entityCount: 3, realtime: true, kind: 'sandbox', pvp: false }]);
      }
      if (url.endsWith('/scenarios') && method === 'GET') {
        return json([{ id: 'goblin-ambush', meta: { name: 'Goblin Ambush', description: 'Defend the town.' } }]);
      }
      if (url.endsWith('/instances/inst-1') && method === 'GET') {
        return json({ id: 'inst-1', tick: 13, state: 'running', entityCount: 3, realtime: true, kind: 'sandbox', pvp: false });
      }
      if (url.endsWith('/instances/inst-2') && method === 'GET') {
        return json({ id: 'inst-2', tick: 0, state: 'running', entityCount: 2, realtime: true, kind: 'scenario', pvp: false });
      }
      if (url.endsWith('/mcp') && method === 'POST') {
        const message = body as { readonly method?: string };
        if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'mcp-session-id': 'session-1' } });
        if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
        return json({
          jsonrpc: '2.0', id: 2,
          result: { content: [{ type: 'text', text: JSON.stringify({ instanceId: 'inst-2', adminToken: 'must-not-be-rendered' }) }] },
        });
      }
      if (url.endsWith('/mcp') && method === 'DELETE') return new Response(null, { status: 204 });
      return json({ error: 'not found' }, { status: 404 });
    };

    const directory = createRuneSchoolWorldDirectory('https://game.example/', { fetch: fetcher });
    expect(await directory.listInstances()).toEqual([{
      id: 'inst-1', tick: 12, state: 'running', entityCount: 3,
      realtime: true, kind: 'sandbox', pvp: false,
    }]);
    expect(await directory.listScenarios()).toEqual([{
      id: 'goblin-ambush', name: 'Goblin Ambush', description: 'Defend the town.',
    }]);
    expect((await directory.connect('inst-1')).tick).toBe(13);
    expect((await directory.spawnScenario('goblin-ambush')).id).toBe('inst-2');
    await directory.close();

    expect(calls.some((entry) => entry.url === 'https://game.example/instances')).toBe(true);
    expect(calls.some((entry) => {
      const bodyValue = entry.body as { readonly params?: { readonly name?: string } } | undefined;
      return bodyValue?.params?.name === 'start_scenario';
    })).toBe(true);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  test('reports an unavailable backend instead of returning fake worlds', async () => {
    const directory = createRuneSchoolWorldDirectory('https://offline.example', {
      fetch: async () => { throw new Error('connection refused'); },
    });
    await expect(directory.listInstances()).rejects.toThrow('backend unavailable');
    await directory.close();
  });
});
