import type { JsonValue } from '#protocol';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../core/model.ts';

export class ModelWireError extends Error {
  constructor(message: string, readonly body: unknown) {
    super(message);
    this.name = 'ModelWireError';
  }
}

export interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export type WireMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string; readonly name?: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly WireToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface WireTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonValue;
  };
}

export function toWireMessages(messages: readonly ChatMessage[]): readonly WireMessage[] {
  return messages.map((message): WireMessage => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return message.name === undefined
          ? { role: 'user', content: message.content }
          : { role: 'user', content: message.content, name: message.name };
      case 'assistant': {
        const toolCalls = message.toolCalls?.map((call): WireToolCall => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }));
        return toolCalls === undefined
          ? { role: 'assistant', content: message.content }
          : { role: 'assistant', content: message.content, tool_calls: toolCalls };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

export function toWireTools(tools: readonly ToolDefinition[]): readonly WireTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, body: unknown): never {
  throw new ModelWireError(message, body);
}

function parseToolCalls(value: unknown, body: unknown): readonly {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('Model response message.tool_calls must be an array', body);
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.type !== 'function'
      || !isRecord(entry.function) || typeof entry.function.name !== 'string'
      || typeof entry.function.arguments !== 'string') {
      fail(`Model response message.tool_calls.${index} is malformed`, body);
    }
    return {
      id: entry.id,
      name: entry.function.name,
      arguments: entry.function.arguments
    };
  });
}

function parseUsage(value: unknown, body: unknown): ChatResponse['usage'] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.prompt_tokens !== 'number'
    || typeof value.completion_tokens !== 'number' || typeof value.total_tokens !== 'number') {
    fail('Model response usage is malformed', body);
  }
  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens
  };
}

function finishReason(value: unknown): ChatResponse['finishReason'] {
  switch (value) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
      return value;
    default:
      return 'other';
  }
}

export function fromWireResponse(body: unknown, model: string, latencyMs: number): ChatResponse {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    fail('Model response did not contain choices', body);
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    fail('Model response did not contain an assistant message', body);
  }
  const message = choice.message;
  if (message.content !== null && typeof message.content !== 'string') {
    fail('Model response message.content must be a string or null', body);
  }
  const toolCalls = parseToolCalls(message.tool_calls, body);
  const assistantMessage: Extract<ChatMessage, { role: 'assistant' }> = toolCalls === undefined
    ? { role: 'assistant', content: message.content }
    : { role: 'assistant', content: message.content, toolCalls };
  const usage = parseUsage(body.usage, body);
  return {
    message: assistantMessage,
    finishReason: finishReason(choice.finish_reason),
    ...(usage === undefined ? {} : { usage }),
    latencyMs,
    model,
    raw: body as JsonValue
  };
}
