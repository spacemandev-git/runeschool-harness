import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { AgentIdentity } from '../core/transport.ts';
import { createHostedWorldClient } from './hostedWorld.ts';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    encoded = BASE58_ALPHABET[Number(number % 58n)]! + encoded;
    number /= 58n;
  }
  return '1'.repeat(leadingZeroes) + encoded;
}

function testIdentity(): { readonly identity: AgentIdentity; readonly publicKey: KeyObject } {
  const keys = generateKeyPairSync('ed25519');
  const jwk = keys.publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('missing Ed25519 x coordinate');
  const identity: AgentIdentity = {
    publicKey: encodeBase58(Buffer.from(jwk.x, 'base64url')),
    async sign(message) {
      return sign(null, Buffer.from(message, 'utf8'), keys.privateKey);
    },
  };
  return { identity, publicKey: keys.publicKey };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(
  handlers: readonly ((request: RecordedRequest) => Response | Promise<Response>)[],
  requests: RecordedRequest[],
): typeof fetch {
  let index = 0;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const request: RecordedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body,
    };
    requests.push(request);
    const handler = handlers[index++];
    if (handler === undefined) throw new Error('unexpected fetch');
    return await handler(request);
  }) as typeof fetch;
}

function successfulHandlers(publicKey: string, finalResponse?: Response): readonly ((request: RecordedRequest) => Response)[] {
  return [
    () => jsonResponse({
      challengeId: 'challenge-1',
      publicKey,
      kind: 'agent',
      message: 'Sign in with Solana\nNonce: exact-bytes',
      expiresAt: 2_000_000_000_000,
    }, 201),
    () => jsonResponse({
      token: 'bearer-session-secret',
      expiresAt: 2_000_000_000_000,
      identity: { publicKey, kind: 'agent', displayName: 'Agent' },
      masterAdmin: false,
    }),
    () => finalResponse ?? jsonResponse({
      instanceId: 'instance / one',
      entity: 42,
      actorToken: 'durable-actor-secret',
      actorTag: 'wallet-0123456789abcdef0123456789abcdef',
      region: { key: 'lumbridge', regionId: 7 },
      identity: { publicKey, kind: 'agent', displayName: 'Agent' },
    }),
  ];
}

describe('createHostedWorldClient', () => {
  test('signs in as an agent, joins with the bearer token, and returns actor credentials', async () => {
    const { identity, publicKey } = testIdentity();
    const requests: RecordedRequest[] = [];
    const client = createHostedWorldClient({
      backendUrl: 'https://backend.test///',
      fetch: fakeFetch(successfulHandlers(identity.publicKey), requests),
    });

    const credentials = await client.join(identity, { displayName: `  ${'A'.repeat(90)}  ` });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['POST', 'https://backend.test/auth/challenge'],
      ['POST', 'https://backend.test/auth/verify'],
      ['POST', 'https://backend.test/world/live/join'],
    ]);
    expect(requests[0]?.body).toEqual({ publicKey: identity.publicKey, kind: 'agent' });

    const verifyBody = requests[1]?.body as Record<string, unknown>;
    expect(verifyBody.challengeId).toBe('challenge-1');
    expect(verifyBody.publicKey).toBe(identity.publicKey);
    expect(verifyBody.displayName).toBe('A'.repeat(80));
    expect(verify(
      null,
      Buffer.from('Sign in with Solana\nNonce: exact-bytes', 'utf8'),
      publicKey,
      Buffer.from(String(verifyBody.signature), 'base64'),
    )).toBe(true);
    expect(Buffer.from(String(verifyBody.signature), 'base64')).toHaveLength(64);

    expect(requests[2]?.headers.get('authorization')).toBe('Bearer bearer-session-secret');
    expect(requests[2]?.body).toEqual({});
    expect(credentials).toEqual({
      instanceId: 'instance / one',
      httpUrl: 'https://backend.test/instances/instance%20%2F%20one',
      wsUrl: 'wss://backend.test/instances/instance%20%2F%20one/stream',
      tag: 'wallet-0123456789abcdef0123456789abcdef',
      entity: 42,
      token: 'durable-actor-secret',
    });
  });

  test('returns hosted-world status and treats 404 or invalid JSON as absent', async () => {
    const requests: RecordedRequest[] = [];
    const client = createHostedWorldClient({
      backendUrl: 'http://backend.test',
      fetch: fakeFetch([
        () => new Response(null, { status: 404 }),
        () => jsonResponse({
          worldId: 'world-1', status: 'ready', instanceId: 'instance-1', name: 'Live',
          regionCount: 2, participantCount: 3, realtime: true, pvp: false,
        }),
        () => new Response('not json'),
      ], requests),
    });

    expect(await client.status()).toBeUndefined();
    expect(await client.status()).toEqual({
      instanceId: 'instance-1', status: 'ready', name: 'Live', pvp: false, participantCount: 3,
    });
    expect(await client.status()).toBeUndefined();
  });

  test('reports a 409 eliminated join without leaking the bearer token', async () => {
    const { identity } = testIdentity();
    const requests: RecordedRequest[] = [];
    const eliminated = jsonResponse({ error: 'eliminated', message: 'This identity was eliminated' }, 409);
    const client = createHostedWorldClient({
      backendUrl: 'https://backend.test',
      fetch: fakeFetch(successfulHandlers(identity.publicKey, eliminated), requests),
    });

    let message = '';
    try {
      await client.join(identity);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith('HostedWorld:');
    expect(message).toContain('HTTP 409');
    expect(message).toContain('eliminated');
    expect(message).not.toContain('bearer-session-secret');
  });
});
