/** Durable per-agent Ed25519 identities stored as mode-0600 PKCS#8 key files. */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signEd25519,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentIdentity, AgentIdentityStore } from '../core/transport.ts';

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

interface StoredIdentity {
  readonly version: 1;
  readonly agentId: string;
  readonly publicKey: string;
  readonly privateKeyPem: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;

  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder]! + encoded;
    value /= 58n;
  }
  return '1'.repeat(leadingZeroes) + encoded;
}

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) throw new Error('public key must not be empty');
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) throw new Error('public key is not valid base58');
    number = number * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number % 256n));
    number /= 256n;
  }
  bytes.reverse();
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...new Array<number>(leadingZeroes).fill(0), ...bytes]);
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('private key is not an Ed25519 key');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.byteLength !== 32) throw new Error('Ed25519 public key is not 32 bytes');
  return raw;
}

function identityFromKey(privateKey: KeyObject, publicKey: string): AgentIdentity {
  return {
    publicKey,
    async sign(message): Promise<Uint8Array> {
      const signature = signEd25519(null, Buffer.from(message, 'utf8'), privateKey);
      if (signature.byteLength !== 64) throw new Error('Ed25519 signature is not 64 bytes');
      return signature;
    },
  };
}

function parseStoredIdentity(value: unknown, expectedAgentId: string): {
  readonly stored: StoredIdentity;
  readonly privateKey: KeyObject;
} {
  if (!isRecord(value)
    || value.version !== 1
    || value.agentId !== expectedAgentId
    || typeof value.publicKey !== 'string'
    || typeof value.privateKeyPem !== 'string') {
    throw new Error(`AgentIdentityStore: invalid identity file for ${JSON.stringify(expectedAgentId)}`);
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(value.privateKeyPem);
  } catch {
    throw new Error(`AgentIdentityStore: invalid private key for ${JSON.stringify(expectedAgentId)}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`AgentIdentityStore: private key is not Ed25519 for ${JSON.stringify(expectedAgentId)}`);
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase58(value.publicKey);
  } catch {
    throw new Error(`AgentIdentityStore: invalid public key for ${JSON.stringify(expectedAgentId)}`);
  }
  const derived = encodeBase58(rawPublicKey(privateKey));
  if (decoded.byteLength !== 32 || derived !== value.publicKey) {
    throw new Error(`AgentIdentityStore: public and private keys do not match for ${JSON.stringify(expectedAgentId)}`);
  }

  return { stored: value as unknown as StoredIdentity, privateKey };
}

async function loadIdentity(path: string, agentId: string): Promise<AgentIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error(`AgentIdentityStore: could not read identity for ${JSON.stringify(agentId)}`);
  }
  const { stored, privateKey } = parseStoredIdentity(parsed, agentId);
  await chmod(path, 0o600);
  return identityFromKey(privateKey, stored.publicKey);
}

export function createAgentIdentityStore(directory: string): AgentIdentityStore {
  return {
    async ensure(agentId): Promise<AgentIdentity> {
      if (!AGENT_ID.test(agentId)) {
        throw new Error(`AgentIdentityStore: invalid agent id ${JSON.stringify(agentId)}`);
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = join(directory, `${agentId}.json`);

      try {
        return await loadIdentity(path, agentId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const { privateKey } = generateKeyPairSync('ed25519');
      const publicKey = encodeBase58(rawPublicKey(privateKey));
      const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const stored: StoredIdentity = { version: 1, agentId, publicKey, privateKeyPem };
      try {
        await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        });
        await chmod(path, 0o600);
        return identityFromKey(privateKey, publicKey);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await loadIdentity(path, agentId);
      }
    },
  };
}
