import type { JsonValue } from '#protocol';
import type { ChatRequest, ChatResponse, ModelProvider } from '../core/model.ts';

type ScriptedResponse = Partial<ChatResponse> | ((request: ChatRequest) => Partial<ChatResponse>);

export interface MockProvider extends ModelProvider {
  readonly requests: readonly ChatRequest[];
  enqueue(response: ScriptedResponse): void;
  respondWith(matcher: (request: ChatRequest) => boolean, response: ScriptedResponse): void;
  reset(): void;
}

function materialize(response: ScriptedResponse, request: ChatRequest): Partial<ChatResponse> {
  return typeof response === 'function' ? response(request) : response;
}

function complete(partial: Partial<ChatResponse>, request: ChatRequest): ChatResponse {
  return {
    message: partial.message ?? { role: 'assistant', content: '(mock: no scripted response)' },
    finishReason: partial.finishReason ?? 'stop',
    ...(partial.usage === undefined ? {} : { usage: partial.usage }),
    latencyMs: partial.latencyMs ?? 0,
    model: partial.model ?? request.model,
    ...(partial.raw === undefined ? {} : { raw: partial.raw })
  };
}

export function createMockProvider(options: { readonly id?: string } = {}): MockProvider {
  const requests: ChatRequest[] = [];
  const queue: ScriptedResponse[] = [];
  const matched: { matcher: (request: ChatRequest) => boolean; response: ScriptedResponse }[] = [];
  return {
    id: options.id ?? 'mock',
    requests,
    async chat(request, signal): Promise<ChatResponse> {
      if (signal?.aborted === true) throw signal.reason;
      requests.push(request);
      const match = matched.find((entry) => entry.matcher(request));
      const response = match?.response ?? queue.shift();
      return complete(response === undefined ? {} : materialize(response, request), request);
    },
    enqueue(response): void {
      queue.push(response);
    },
    respondWith(matcher, response): void {
      matched.push({ matcher, response });
    },
    reset(): void {
      requests.splice(0);
      queue.splice(0);
      matched.splice(0);
    }
  };
}

export function assistantText(text: string): Partial<ChatResponse> {
  return { message: { role: 'assistant', content: text }, finishReason: 'stop' };
}

export function assistantToolCall(
  name: string,
  args: string | JsonValue,
  id = 'call_mock'
): Partial<ChatResponse> {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }]
    },
    finishReason: 'tool_calls'
  };
}
