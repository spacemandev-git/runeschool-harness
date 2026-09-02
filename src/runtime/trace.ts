import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessBus } from '../core/index.ts';

export const SECRET_KEYS = new Set([
  'authorization', 'api_key', 'apikey', 'access_token', 'refreshtoken',
  'refresh_token', 'secret', 'token', 'mcp-session-id',
  'nous_api_key', 'nous_key', 'or_key'
]);

const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|credential|session[-_]?id/i;

function isSensitiveKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY.test(key);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch { return value; }
}

function defaultSecretValues(): readonly string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => isSensitiveKey(key) && value !== undefined && value.length > 0)
    .map(([, value]) => value as string);
}

function redactString(value: string, secrets: readonly string[]): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.stringify(redactSecrets(JSON.parse(value), '', secrets)); } catch { /* ordinary text */ }
  }
  let redacted = redactUrl(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/("token"\s*:\s*")[^"]+("?)/gi, '$1[REDACTED]$2');
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted;
}

export function redactSecrets(value: unknown, key = '', secrets: readonly string[] = defaultSecretValues()): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, '', secrets));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) =>
      [entryKey, redactSecrets(entry, entryKey, secrets)]));
  }
  return value;
}

export interface JsonlTrace {
  readonly path: string;
  close(): void;
}

export function createJsonlTrace(bus: HarnessBus, logDir: string, runId: string): JsonlTrace {
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${runId}.jsonl`);
  const fd = openSync(path, 'wx', 0o600);
  chmodSync(path, 0o600);
  let closed = false;
  const unsubscribe = bus.onAny((event) => {
    if (!closed) writeSync(fd, `${JSON.stringify(redactSecrets(event))}\n`);
  });
  return {
    path,
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      closeSync(fd);
    }
  };
}
