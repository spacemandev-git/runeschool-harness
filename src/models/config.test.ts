import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../bus/index.ts';
import { createJsonlTrace } from '../runtime/trace.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig, ModelConfigError } from './config.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function configFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'model-config-'));
  directories.push(directory);
  const path = join(directory, 'models.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('model configuration', () => {
  test('builds defaults from the supplied environment', () => {
    const config = loadModelConfig(undefined, {
      ROUTER_API_BASE: 'https://router.test/v2',
      ROUTER_API_KEY: 'router-key',
      ROUTER_MODEL: 'openai/custom',
      HARNESS_MODEL_ADMIN: 'router:admin/model',
      HARNESS_MODEL_AGENT: 'agent/model'
    });
    expect(config.providers).toEqual({
      router: {
        kind: 'openai-compatible', baseUrl: 'https://router.test/v2', apiKeyEnv: 'ROUTER_API_KEY'
      }
    });
    expect(DEFAULT_MODEL_CONFIG.providers.router).toBeDefined();
    expect(config.roles.director).toEqual({ provider: 'router', model: 'openai/custom' });
    expect(config.roles.admin).toEqual({ provider: 'router', model: 'admin/model' });
    expect(config.roles.agent).toEqual({ provider: 'router', model: 'agent/model' });
  });

  test('allows an unauthenticated local OpenAI-compatible router', () => {
    expect(loadModelConfig(undefined, {
      ROUTER_API_BASE: 'http://127.0.0.1:11434/v1'
    }).providers.router).toEqual({
      kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1'
    });
  });

  test('deep-merges JSON over defaults', () => {
    const path = configFile({
      providers: {
        router: { headers: { 'x-test': 'yes' }, maxRetries: 0 },
        test: { kind: 'mock' }
      },
      roles: { agent: { provider: 'test', model: 'scripted', temperature: 0 } },
      agents: { bob: { agent: { model: 'bob-model' } } }
    });
    const config = loadModelConfig(path, {});
    expect(config.providers.router).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      headers: { 'x-test': 'yes' },
      maxRetries: 0
    });
    expect(config.roles.agent).toMatchObject({ provider: 'test', model: 'scripted', temperature: 0 });
    expect(config.agents?.bob?.agent).toEqual({ model: 'bob-model' });
  });

  test('reports dotted validation paths and unknown providers', () => {
    expect(() => loadModelConfig(configFile({
      providers: { bad: { kind: 'openai-compatible', timeoutMs: 'slow' } }
    }), {})).toThrow('providers.bad.timeoutMs');
    try {
      loadModelConfig(configFile({ roles: { agent: { provider: 'missing' } } }), {});
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelConfigError);
      expect(String(error)).toContain('roles.agent.provider');
    }
  });

  test('rejects literal credential headers and accepts environment-backed headers', () => {
    expect(() => loadModelConfig(configFile({
      providers: { router: { headers: { authorization: 'Bearer committed-secret' } } }
    }), {})).toThrow('use apiKeyEnv or headerEnv');
    const config = loadModelConfig(configFile({
      providers: { router: { headerEnv: { 'x-api-key': 'CUSTOM_PROVIDER_KEY' } } }
    }), {});
    expect(config.providers.router?.headerEnv).toEqual({ 'x-api-key': 'CUSTOM_PROVIDER_KEY' });
  });

  test('redacts ROUTER_API_KEY values from serialized model request trace content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'router-trace-'));
    directories.push(directory);
    const previous = process.env.ROUTER_API_KEY;
    process.env.ROUTER_API_KEY = 'router-super-secret';
    try {
      const bus = createBus();
      const trace = createJsonlTrace(bus, directory, 'run-router');
      bus.emit('model.request', {
        role: 'agent', model: 'anthropic/claude-sonnet-4.5', messages: 1, estimatedTokens: 5,
        content: [{ role: 'system', content: 'credential router-super-secret' }]
      });
      trace.close();
      const line = readFileSync(trace.path, 'utf8');
      expect(line).not.toContain('router-super-secret');
      expect(line).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.ROUTER_API_KEY;
      else process.env.ROUTER_API_KEY = previous;
    }
  });
});
