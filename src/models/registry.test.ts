import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { ModelConfig, ModelProvider } from '../core/model.ts';
import { assistantText, createMockProvider } from './mock.ts';
import { createModelRegistry, ModelAuthError, ModelResolveError } from './registry.ts';

function config(): ModelConfig {
  return {
    providers: { one: { kind: 'mock' }, two: { kind: 'mock' } },
    roles: {
      director: { provider: 'one', model: 'base' },
      coordinator: { provider: 'one', model: 'base' },
      agent: { provider: 'one', model: 'base', temperature: 0.4 },
      summarizer: { provider: 'one', model: 'base' },
      admin: { provider: 'one', model: 'base' }
    },
    agents: { alice: { agent: { provider: 'two', model: 'agent-config' } } }
  };
}

describe('model registry', () => {
  test('resolves role, agent configuration, then runtime override', () => {
    const registry = createModelRegistry(config(), { bus: createBus() });
    expect(registry.resolve('agent').model).toBe('base');
    expect(registry.resolve('agent', 'alice')).toMatchObject({ provider: 'two', model: 'agent-config' });
    registry.setOverride('alice', 'agent', { model: 'runtime', temperature: 0.1 });
    expect(registry.resolve('agent', 'alice')).toMatchObject({
      provider: 'two', model: 'runtime', temperature: 0.1
    });
    registry.clearOverride('alice', 'agent');
    expect(registry.resolve('agent', 'alice').model).toBe('agent-config');
  });

  test('names missing providers in resolution errors', () => {
    const broken = config();
    const registry = createModelRegistry({
      ...broken,
      roles: { ...broken.roles, agent: { provider: 'absent', model: 'm' } }
    }, { bus: createBus() });
    expect(() => registry.resolve('agent', 'bob')).toThrow(ModelResolveError);
    expect(() => registry.resolve('agent', 'bob')).toThrow('absent');
  });

  test('calls an injected mock, accounts all keys, and emits safe events', async () => {
    const bus = createBus();
    const mock = createMockProvider({ id: 'one' });
    mock.enqueue({
      ...assistantText('done'),
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });
    const registry = createModelRegistry(config(), { bus, providers: { one: mock } });
    const response = await registry.chat('agent', {
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 9
    }, { agentId: 'bob' });
    expect(response.message.content).toBe('done');
    expect(mock.requests[0]).toMatchObject({ model: 'base', temperature: 0.4, maxTokens: 9 });
    expect(registry.usage()).toEqual([
      { key: 'agent', calls: 1, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, errors: 0 },
      { key: 'agent:bob', calls: 1, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, errors: 0 },
      { key: 'model:base', calls: 1, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, errors: 0 }
    ]);
    expect(bus.history({ prefix: 'model.' }).map((event) => event.type))
      .toEqual(['model.request', 'model.response']);
  });

  test('rejects missing configured credentials at call time', async () => {
    const base = config();
    const authConfig: ModelConfig = {
      ...base,
      providers: {
        nous: { kind: 'openai-compatible', baseUrl: 'https://example.test', apiKeyEnv: 'NOUS_API_KEY' }
      },
      roles: Object.fromEntries(Object.keys(base.roles).map((role) => [role, {
        provider: 'nous', model: 'm'
      }])) as unknown as ModelConfig['roles']
    };
    const registry = createModelRegistry(authConfig, { bus: createBus(), env: {} });
    await expect(registry.chat('agent', { messages: [] })).rejects.toEqual(
      new ModelAuthError('NOUS_API_KEY is not set')
    );
  });

  test('redacts bearer credentials from failure bus events', async () => {
    const bus = createBus();
    const failing: ModelProvider = {
      id: 'one',
      async chat() { throw new Error('request had Bearer very-secret-value'); }
    };
    const registry = createModelRegistry(config(), { bus, providers: { one: failing } });
    await expect(registry.chat('agent', { messages: [] })).rejects.toThrow('very-secret-value');
    expect(JSON.stringify(bus.history())).not.toContain('very-secret-value');
  });
});
