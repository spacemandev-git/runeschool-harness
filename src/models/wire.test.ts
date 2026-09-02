import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ToolDefinition } from '../core/model.ts';
import { fromWireResponse, ModelWireError, toWireMessages, toWireTools } from './wire.ts';

describe('OpenAI wire conversion', () => {
  test('converts every message role and tool calls', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello', name: 'operator' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call-1', name: 'walk', arguments: '{"x":1}' }]
      },
      { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' }
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello', name: 'operator' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'walk', arguments: '{"x":1}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }
    ]);
  });

  test('converts tool schemas and responses without parsing arguments', () => {
    const tools: ToolDefinition[] = [{ name: 'walk', description: 'Walk', parameters: { type: 'object' } }];
    expect(toWireTools(tools)).toEqual([{
      type: 'function',
      function: { name: 'walk', description: 'Walk', parameters: { type: 'object' } }
    }]);
    const raw = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'walk', arguments: '{not parsed}' }
          }]
        }
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
    };
    expect(fromWireResponse(raw, 'model-a', 17)).toMatchObject({
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call-1', name: 'walk', arguments: '{not parsed}' }]
      },
      finishReason: 'tool_calls',
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      latencyMs: 17,
      model: 'model-a'
    });
  });

  test('preserves missing usage and maps unknown finish reasons', () => {
    const response = fromWireResponse({
      choices: [{ finish_reason: 'end_turn', message: { content: 'done' } }]
    }, 'm', 1);
    expect(response.usage).toBeUndefined();
    expect(response.finishReason).toBe('other');
  });

  test('rejects malformed bodies with the original body attached', () => {
    const body = { choices: [{ message: { content: 42 } }] };
    try {
      fromWireResponse(body, 'm', 0);
      throw new Error('expected conversion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelWireError);
      expect((error as ModelWireError).body).toBe(body);
    }
  });
});
