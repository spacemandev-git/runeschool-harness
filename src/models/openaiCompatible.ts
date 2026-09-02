import type { ChatRequest, ChatResponse, ModelProvider } from '../core/model.ts';
import { fromWireResponse, ModelWireError, toWireMessages, toWireTools } from './wire.ts';

export interface OpenAiCompatibleOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly attempts: number
  ) {
    super(status === 0
      ? `Model request failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${bodyText}`
      : `Model request failed with HTTP ${status} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${bodyText}`);
    this.name = 'ModelHttpError';
  }
}

function cleanText(text: string, apiKey: string | undefined): string {
  let clean = text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  if (apiKey !== undefined && apiKey.length > 0) clean = clean.split(apiKey).join('[REDACTED]');
  return clean;
}

function errorText(error: unknown, apiKey: string | undefined): string {
  return cleanText(error instanceof Error ? error.message : String(error), apiKey);
}

function cleanBody(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === 'string') return cleanText(value, apiKey);
  if (Array.isArray(value)) return value.map((entry) => cleanBody(entry, apiKey));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cleanBody(entry, apiKey)]));
  }
  return value;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function retryDelay(retryIndex: number): number {
  const base = Math.min(4_000, 250 * (2 ** retryIndex));
  return Math.max(1, Math.round(base * (0.5 + Math.random())));
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): ModelProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 2;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...options.headers,
    ...(options.apiKey === undefined || options.apiKey.length === 0
      ? {}
      : { authorization: `Bearer ${options.apiKey}` })
  });

  async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWireMessages(request.messages)
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = toWireTools(request.tools);
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.responseFormat === 'json') body.response_format = { type: 'json_object' };
    Object.assign(body, request.extra);

    const startedAt = now();
    let lastError = 'network error';
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (signal?.aborted === true) throw signal.reason;
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
          signal: attemptSignal(signal, timeoutMs)
        });
        const responseText = await response.text();
        if (!response.ok) {
          const clean = cleanText(responseText, options.apiKey);
          if (isRetryable(response.status) && attempt <= maxRetries) {
            lastError = clean;
            await wait(retryDelay(attempt - 1), signal);
            continue;
          }
          throw new ModelHttpError(response.status, clean, attempt);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText) as unknown;
        } catch {
          throw new ModelWireError('Model response was not valid JSON', responseText);
        }
        return fromWireResponse(parsed, request.model, Math.max(0, now() - startedAt));
      } catch (error) {
        if (error instanceof ModelHttpError) throw error;
        if (error instanceof ModelWireError) {
          throw new ModelWireError(cleanText(error.message, options.apiKey), cleanBody(error.body, options.apiKey));
        }
        signal?.throwIfAborted();
        lastError = errorText(error, options.apiKey);
        if (attempt <= maxRetries) {
          await wait(retryDelay(attempt - 1), signal);
          continue;
        }
        throw new ModelHttpError(0, lastError, attempt);
      }
    }
    throw new ModelHttpError(0, lastError, maxRetries + 1);
  }

  async function listModels(): Promise<readonly string[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new ModelHttpError(0, errorText(error, options.apiKey), 1);
    }
    const text = await response.text();
    if (!response.ok) throw new ModelHttpError(response.status, cleanText(text, options.apiKey), 1);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ModelWireError('Model list response was not valid JSON', cleanText(text, options.apiKey));
    }
    if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)
      || body.data.some((entry) => typeof entry !== 'object' || entry === null
        || !('id' in entry) || typeof entry.id !== 'string')) {
      throw new ModelWireError('Model list response data is malformed', cleanBody(body, options.apiKey));
    }
    return body.data.map((entry) => (entry as { id: string }).id).sort();
  }

  return { id: options.id, chat, listModels };
}
