import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import type { MemoryRecord, MemoryStore } from '../core/memory.ts';
import type { ModelConfig, ModelProvider } from '../core/model.ts';
import { assistantText, createMockProvider } from '../models/mock.ts';
import { createModelRegistry } from '../models/registry.ts';
import { createContextManager } from './contextManager.ts';

function config(): ModelConfig {
  const spec = { provider: 'mock', model: 'test' };
  return { providers: { mock: { kind: 'mock' } }, roles: {
    director: spec, coordinator: spec, agent: spec, summarizer: spec, admin: spec
  } };
}

function memory(writes: MemoryRecord[]): MemoryStore {
  return {
    agentId: 'agent',
    async remember(input) {
      const row: MemoryRecord = { id: writes.length + 1, agentId: 'agent', kind: input.kind, text: input.text,
        tags: input.tags ?? [], importance: input.importance ?? 0.5, runId: 'run-test', createdAt: 0, recallCount: 0 };
      writes.push(row); return row;
    },
    async recall() { return []; }, async forget() { return false; }, async update() { return undefined; },
    async recent() { return []; }, async count() { return writes.length; }, close() {}
  };
}

describe('context manager', () => {
  test('compacts old turns, keeps recent turns, and journals the summary', async () => {
    const bus = createBus();
    const mock = createMockProvider();
    mock.enqueue(assistantText('Learned one fact; still walking east.'));
    const writes: MemoryRecord[] = [];
    const manager = createContextManager({
      role: 'agent', agentId: 'agent', models: createModelRegistry(config(), { bus, providers: { mock } }),
      estimator: { estimate: (text) => text.length },
      budget: { maxPromptTokens: 1_000, compactAtTokens: 30, keepTurns: 1, recallLimit: 2 },
      bus, memory: memory(writes), systemPrompt: () => 'system'
    });
    manager.push({ role: 'user', content: 'first old request' });
    manager.push({ role: 'assistant', content: 'first old answer' });
    manager.push({ role: 'user', content: 'latest request' });
    manager.push({ role: 'assistant', content: 'latest answer' });
    await manager.maybeCompact();
    expect(manager.transcript().map((entry) => entry.content)).toEqual([
      'system', 'Summary of earlier activity:\nLearned one fact; still walking east.', 'latest request', 'latest answer'
    ]);
    expect(writes[0]).toMatchObject({ kind: 'journal', importance: 0.4 });
    expect(manager.stats().compactions).toBe(1);
  });

  test('drops old turns and warns when summarization fails', async () => {
    const bus = createBus();
    const failing: ModelProvider = { id: 'mock', async chat() { throw new Error('offline'); } };
    const manager = createContextManager({
      role: 'agent', agentId: 'agent', models: createModelRegistry(config(), { bus, providers: { mock: failing } }),
      estimator: { estimate: (text) => text.length },
      budget: { maxPromptTokens: 1_000, compactAtTokens: 10, keepTurns: 1, recallLimit: 2 },
      bus, systemPrompt: () => 'system'
    });
    manager.push({ role: 'user', content: 'old request' });
    manager.push({ role: 'assistant', content: 'old answer' });
    manager.push({ role: 'user', content: 'latest' });
    await manager.maybeCompact();
    expect(manager.transcript().map((entry) => entry.content)).toEqual(['system', 'latest']);
    expect(bus.history().some((event) => event.type === 'log' && event.data.level === 'warn')).toBe(true);
  });

  test('truncates tool results on push', () => {
    const bus = createBus();
    const manager = createContextManager({
      role: 'agent', models: createModelRegistry(config(), { bus }), estimator: { estimate: () => 0 },
      budget: { maxPromptTokens: 1_000, compactAtTokens: 1_000, keepTurns: 1, recallLimit: 2 },
      bus, systemPrompt: () => 'system'
    });
    manager.push({ role: 'tool', toolCallId: 'x', content: 'x'.repeat(3_000) });
    expect(manager.transcript()[1]?.content).toHaveLength(2_000);
  });
});
