import { describe, expect, test } from 'bun:test';
import { charEstimator, estimateMessages, estimateTokens } from './tokens.ts';

describe('character token estimator', () => {
  test('uses 3.6 characters per token rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('1234')).toBe(2);
    expect(charEstimator.estimate('1234567')).toBe(2);
  });

  test('includes message overhead, tool arguments, and schemas', () => {
    const messages = [{
      role: 'assistant' as const,
      content: null,
      toolCalls: [{ id: '1', name: 'x', arguments: '1234' }]
    }];
    const tools = [{ name: 'x', description: 'x', parameters: { type: 'object' } }];
    expect(estimateMessages(messages, tools)).toBe(
      4 + estimateTokens('1234') + estimateTokens(JSON.stringify(tools))
    );
  });
});
