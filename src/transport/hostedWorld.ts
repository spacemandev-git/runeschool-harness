/** Hosted-world client: signed agent sign-in followed by `POST /world/live/join`. */
import type {
  ActorCredentials,
  HostedWorldClient,
  HostedWorldStatus,
} from '../core/transport.ts';

export interface HostedWorldClientOptions {
  /** Backend base URL, e.g. `https://api.runeschool.dev` (no trailing slash). */
  readonly backendUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`HostedWorld: invalid response; '${path}' must be an object`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`HostedWorld: invalid response; '${path}' must be a non-empty string`);
  }
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`HostedWorld: invalid response; '${path}' must be a finite number`);
  }
  return value;
}

function requiredExpiry(value: unknown, path: string): void {
  if ((typeof value !== 'string' || value.length === 0)
    && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`HostedWorld: invalid response; '${path}' must be a string or finite number`);
  }
}

async function responseJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json() as unknown;
  } catch {
    return undefined;
  }
}

function redactKnown(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe;
}

function responseSecrets(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const secrets: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /token|authorization|privateKey|signature/i.test(key)) {
      secrets.push(entry);
    } else if (isRecord(entry)) {
      secrets.push(...responseSecrets(entry));
    }
  }
  return secrets;
}

function httpError(
  method: string,
  path: string,
  response: Response,
  body: unknown,
  secrets: readonly string[] = [],
): Error {
  const fields = isRecord(body) ? body : undefined;
  const allSecrets = [...secrets, ...responseSecrets(body)];
  const code = typeof fields?.error === 'string' ? redactKnown(fields.error, allSecrets) : undefined;
  const message = typeof fields?.message === 'string' ? redactKnown(fields.message, allSecrets) : undefined;
  const detail = [code, message].filter((entry): entry is string => entry !== undefined).join(': ');
  return new Error(
    `HostedWorld: ${method} ${path} failed (HTTP ${response.status}${detail.length > 0 ? `, ${detail}` : ''})`,
  );
}

function parsedStatus(value: unknown): HostedWorldStatus | undefined {
  if (!isRecord(value)
    || typeof value.instanceId !== 'string'
    || value.instanceId.length === 0
    || typeof value.status !== 'string'
    || value.status.length === 0
    || typeof value.pvp !== 'boolean'
    || (value.name !== undefined && typeof value.name !== 'string')
    || (value.participantCount !== undefined
      && (typeof value.participantCount !== 'number' || !Number.isFinite(value.participantCount)))) {
    return undefined;
  }
  return {
    instanceId: value.instanceId,
    status: value.status,
    pvp: value.pvp,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.participantCount === undefined ? {} : { participantCount: value.participantCount }),
  };
}

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/stream`;
  return url.toString();
}

export function createHostedWorldClient(options: HostedWorldClientOptions): HostedWorldClient {
  const backendUrl = options.backendUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let parsedBackend: URL;
  try {
    parsedBackend = new URL(backendUrl);
  } catch {
    throw new Error('HostedWorld: backendUrl must be an absolute HTTP(S) URL');
  }
  if ((parsedBackend.protocol !== 'http:' && parsedBackend.protocol !== 'https:') || backendUrl.length === 0) {
    throw new Error('HostedWorld: backendUrl must be an absolute HTTP(S) URL');
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${backendUrl}${path}`, init);
    } catch {
      throw new Error(`HostedWorld: ${init?.method ?? 'GET'} ${path} request failed`);
    }
  }

  async function post(path: string, body: Readonly<Record<string, unknown>>): Promise<{
    readonly response: Response;
    readonly value: unknown | undefined;
  }> {
    const response = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, value: await responseJson(response) };
  }

  return {
    backendUrl,
    async status(): Promise<HostedWorldStatus | undefined> {
      const response = await request('/world/live');
      if (response.status === 404) return undefined;
      const value = await responseJson(response);
      if (!response.ok) throw httpError('GET', '/world/live', response, value);
      return parsedStatus(value);
    },
    async join(identity, joinOptions): Promise<ActorCredentials> {
      const publicKey = requiredString(identity.publicKey, 'identity.publicKey');
      const challengeResult = await post('/auth/challenge', { publicKey, kind: 'agent' });
      if (!challengeResult.response.ok) {
        throw httpError('POST', '/auth/challenge', challengeResult.response, challengeResult.value);
      }
      const challenge = requiredRecord(challengeResult.value, 'challenge');
      const challengeId = requiredString(challenge.challengeId, 'challenge.challengeId');
      const challengedPublicKey = requiredString(challenge.publicKey, 'challenge.publicKey');
      const kind = requiredString(challenge.kind, 'challenge.kind');
      const message = requiredString(challenge.message, 'challenge.message');
      requiredExpiry(challenge.expiresAt, 'challenge.expiresAt');
      if (challengedPublicKey !== publicKey) {
        throw new Error('HostedWorld: challenge public key does not match the agent identity');
      }
      if (kind !== 'agent') throw new Error("HostedWorld: challenge kind must be 'agent'");

      let signature: Uint8Array;
      try {
        signature = await identity.sign(message);
      } catch {
        throw new Error('HostedWorld: agent identity could not sign the challenge');
      }
      if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
        throw new Error('HostedWorld: agent identity returned an invalid Ed25519 signature length');
      }
      const displayName = joinOptions?.displayName?.trim().slice(0, 80);
      const verifyResult = await post('/auth/verify', {
        challengeId,
        signature: Buffer.from(signature).toString('base64'),
        publicKey,
        ...(displayName === undefined || displayName.length === 0 ? {} : { displayName }),
      });
      if (!verifyResult.response.ok) {
        throw httpError('POST', '/auth/verify', verifyResult.response, verifyResult.value);
      }
      const verified = requiredRecord(verifyResult.value, 'verify');
      const sessionToken = requiredString(verified.token, 'verify.token');
      requiredExpiry(verified.expiresAt, 'verify.expiresAt');
      if (typeof verified.masterAdmin !== 'boolean') {
        throw new Error("HostedWorld: invalid response; 'verify.masterAdmin' must be a boolean");
      }
      const verifiedIdentity = requiredRecord(verified.identity, 'verify.identity');
      if (requiredString(verifiedIdentity.publicKey, 'verify.identity.publicKey') !== publicKey
        || requiredString(verifiedIdentity.kind, 'verify.identity.kind') !== 'agent') {
        throw new Error('HostedWorld: verified identity does not match the agent identity');
      }
      if (verifiedIdentity.displayName !== undefined && typeof verifiedIdentity.displayName !== 'string') {
        throw new Error("HostedWorld: invalid response; 'verify.identity.displayName' must be a string");
      }

      const joinResponse = await request('/world/live/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({}),
      });
      const joinedValue = await responseJson(joinResponse);
      if (!joinResponse.ok) {
        throw httpError('POST', '/world/live/join', joinResponse, joinedValue, [sessionToken]);
      }
      const joined = requiredRecord(joinedValue, 'join');
      const instanceId = requiredString(joined.instanceId, 'join.instanceId');
      const entity = requiredNumber(joined.entity, 'join.entity');
      const actorToken = requiredString(joined.actorToken, 'join.actorToken');
      const actorTag = requiredString(joined.actorTag, 'join.actorTag');
      // `region` is a { key, regionId } record the harness does not use; tolerate any shape.
      const joinedIdentity = requiredRecord(joined.identity, 'join.identity');
      if (requiredString(joinedIdentity.publicKey, 'join.identity.publicKey') !== publicKey
        || requiredString(joinedIdentity.kind, 'join.identity.kind') !== 'agent') {
        throw new Error('HostedWorld: joined identity does not match the agent identity');
      }
      if (joinedIdentity.displayName !== undefined && typeof joinedIdentity.displayName !== 'string') {
        throw new Error("HostedWorld: invalid response; 'join.identity.displayName' must be a string");
      }

      const httpUrl = `${backendUrl}/instances/${encodeURIComponent(instanceId)}`;
      return {
        instanceId,
        httpUrl,
        wsUrl: websocketUrl(httpUrl),
        tag: actorTag,
        entity,
        token: actorToken,
      };
    },
  };
}
