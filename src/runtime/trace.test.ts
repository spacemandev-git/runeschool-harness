import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../bus/index.ts';
import { createJsonlTrace, redactSecrets } from './trace.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

describe('runtime JSONL trace', () => {
  test('redacts nested fields, JSON strings, URLs, and bearer values', () => {
    const value = redactSecrets({
      token: 'actor-secret', authorization: 'Bearer auth-secret',
      url: 'https://example.test/a?access_token=query-secret&ok=1',
      content: '{"actors":[{"token":"nested-secret"}]}'
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain('actor-secret');
    expect(text).not.toContain('auth-secret');
    expect(text).not.toContain('query-secret');
    expect(text).not.toContain('nested-secret');
  });

  test('writes one owner-only line per bus event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-trace-')); dirs.push(dir);
    const bus = createBus(); const trace = createJsonlTrace(bus, dir, 'run-test');
    bus.emit('log', { level: 'info', scope: 'test', message: 'one' });
    bus.emit('run.finish', { runId: 'run-test', summary: 'done', ok: true });
    trace.close();
    const lines = readFileSync(trace.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(['log', 'run.finish']);
    expect(statSync(trace.path).mode & 0o777).toBe(0o600);
  });

  test('redacts arbitrary credential-shaped environment variables', () => {
    const previous = process.env.CUSTOM_PROVIDER_PASSWORD;
    process.env.CUSTOM_PROVIDER_PASSWORD = 'provider-compatibility-secret';
    try {
      const text = JSON.stringify(redactSecrets({ content: 'key=provider-compatibility-secret' }));
      expect(text).not.toContain('provider-compatibility-secret');
      expect(text).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_PROVIDER_PASSWORD;
      else process.env.CUSTOM_PROVIDER_PASSWORD = previous;
    }
  });

  test('redacts generic key names in fields, URLs, and environment variables', () => {
    const previous = process.env.CUSTOM_ROUTER_KEY;
    process.env.CUSTOM_ROUTER_KEY = 'generic-router-secret';
    try {
      const text = JSON.stringify(redactSecrets({
        custom_router_key: 'field-secret',
        url: 'https://example.test/a?CUSTOM_ROUTER_KEY=query-secret',
        content: 'credential generic-router-secret'
      }));
      expect(text).not.toContain('field-secret');
      expect(text).not.toContain('query-secret');
      expect(text).not.toContain('generic-router-secret');
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_ROUTER_KEY;
      else process.env.CUSTOM_ROUTER_KEY = previous;
    }
  });
});
