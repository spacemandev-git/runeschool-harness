import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentIdentityStore } from './agentIdentity.ts';

const directories: string[] = [];
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-agent-identity-'));
  directories.push(directory);
  return directory;
}

function decodeBase58(value: string): Uint8Array {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('invalid test base58');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number % 256n));
    number /= 256n;
  }
  bytes.reverse();
  return Uint8Array.from([
    ...new Array<number>(value.match(/^1*/)?.[0].length ?? 0).fill(0),
    ...bytes,
  ]);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('createAgentIdentityStore', () => {
  test('persists and reloads the same protected Ed25519 identity', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'identities');
    const first = await createAgentIdentityStore(directory).ensure('agent-one');
    const second = await createAgentIdentityStore(directory).ensure('agent-one');

    expect(second.publicKey).toBe(first.publicKey);
    expect(decodeBase58(first.publicKey)).toHaveLength(32);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'agent-one.json'))).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(await readFile(join(directory, 'agent-one.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 1, agentId: 'agent-one', publicKey: first.publicKey });
    expect(typeof stored.privateKeyPem).toBe('string');
    expect('privateKeyPem' in first).toBe(false);
  });

  test('rejects unsafe agent ids', async () => {
    const directory = join(await temporaryDirectory(), 'identities');
    const store = createAgentIdentityStore(directory);
    for (const agentId of ['', '../escape', 'Uppercase', '-leading', 'a'.repeat(33)]) {
      await expect(store.ensure(agentId)).rejects.toThrow('invalid agent id');
    }
  });
});
