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
      NOUS_BASE_URL: 'https://nous.test/v2',
      NOUS_MODEL: 'openai/custom',
      HARNESS_MODEL_ADMIN: 'nous:admin/model',
      HARNESS_MODEL_AGENT: 'nous:agent/model'
    });
    expect(config.providers.nous?.baseUrl).toBe('https://nous.test/v2');
    expect(config.providers.openrouter).toEqual({
      kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OR_KEY'
    });
    expect(DEFAULT_MODEL_CONFIG.providers.openrouter).toBeDefined();
    expect(config.roles.director).toEqual({ provider: 'nous', model: 'openai/custom' });
    expect(config.roles.admin).toEqual({ provider: 'nous', model: 'admin/model' });
    expect(config.roles.agent).toEqual({ provider: 'nous', model: 'agent/model' });
  });

  test('accepts NOUS_KEY as a compatibility alias while preferring NOUS_API_KEY', () => {
    expect(loadModelConfig(undefined, { NOUS_KEY: 'legacy-key' }).providers.nous?.apiKeyEnv)
      .toBe('NOUS_KEY');
    expect(loadModelConfig(undefined, {
      NOUS_KEY: 'legacy-key',
      NOUS_API_KEY: 'canonical-key'
    }).providers.nous?.apiKeyEnv).toBe('NOUS_API_KEY');
  });

  test('deep-merges JSON over defaults', () => {
    const path = configFile({
      providers: {
        nous: { headers: { 'x-test': 'yes' }, maxRetries: 0 },
        test: { kind: 'mock' }
      },
      roles: { agent: { provider: 'test', model: 'scripted', temperature: 0 } },
      agents: { bob: { agent: { model: 'bob-model' } } }
    });
    const config = loadModelConfig(path, {});
    expect(config.providers.nous).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://inference-api.nousresearch.com/v1',
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
      providers: { nous: { headers: { authorization: 'Bearer committed-secret' } } }
    }), {})).toThrow('use apiKeyEnv or headerEnv');
    const config = loadModelConfig(configFile({
      providers: { nous: { headerEnv: { 'x-api-key': 'CUSTOM_PROVIDER_KEY' } } }
    }), {});
    expect(config.providers.nous?.headerEnv).toEqual({ 'x-api-key': 'CUSTOM_PROVIDER_KEY' });
  });

  test('redacts OR_KEY values from serialized model request trace content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openrouter-trace-'));
    directories.push(directory);
    const previous = process.env.OR_KEY;
    process.env.OR_KEY = 'openrouter-super-secret';
    try {
      const bus = createBus();
      const trace = createJsonlTrace(bus, directory, 'run-openrouter');
      bus.emit('model.request', {
        role: 'agent', model: 'anthropic/claude-sonnet-4.5', messages: 1, estimatedTokens: 5,
        content: [{ role: 'system', content: 'credential openrouter-super-secret' }]
      });
      trace.close();
      const line = readFileSync(trace.path, 'utf8');
      expect(line).not.toContain('openrouter-super-secret');
      expect(line).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.OR_KEY;
      else process.env.OR_KEY = previous;
    }
  });
});
