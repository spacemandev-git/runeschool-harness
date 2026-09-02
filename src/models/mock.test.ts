import { describe, expect, test } from 'bun:test';
import { assistantText, assistantToolCall, createMockProvider } from './mock.ts';

describe('mock model provider', () => {
  test('checks matchers before its FIFO queue and records requests', async () => {
    const mock = createMockProvider({ id: 'test' });
    mock.enqueue(assistantText('queued'));
    mock.respondWith((request) => request.model === 'special', assistantText('matched'));
    expect((await mock.chat({ model: 'special', messages: [] })).message.content).toBe('matched');
    expect((await mock.chat({ model: 'normal', messages: [] })).message.content).toBe('queued');
    expect(mock.requests).toHaveLength(2);
    expect((await mock.chat({ model: 'empty', messages: [] })).message.content)
      .toBe('(mock: no scripted response)');
    mock.reset();
    expect(mock.requests).toHaveLength(0);
  });

  test('builds raw tool call arguments', () => {
    expect(assistantToolCall('walk', { x: 3 }, 'id')).toMatchObject({
      finishReason: 'tool_calls',
      message: { toolCalls: [{ id: 'id', name: 'walk', arguments: '{"x":3}' }] }
    });
  });
});
