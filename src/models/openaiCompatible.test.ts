import { describe, expect, test } from 'bun:test';
import type { ChatRequest } from '../core/model.ts';
import { createOpenAiCompatibleProvider, ModelHttpError } from './openaiCompatible.ts';

const RESPONSE = JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

function fakeFetch(fn: (url: string, init: RequestInit | undefined) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => fn(String(input), init)) as typeof fetch;
}

describe('OpenAI-compatible provider', () => {
  test('sends exact headers and optional body fields', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const provider = createOpenAiCompatibleProvider({
      id: 'router',
      baseUrl: 'https://example.test/v1/',
      headers: { 'x-extra': 'yes' },
      fetch: fakeFetch(async (url, init) => {
        calls.push({ url, init });
        return new Response(RESPONSE);
      })
    });
    const request: ChatRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      maxTokens: 20,
      responseFormat: 'json',
      extra: { seed: 4 }
    };
    await provider.chat(request);
    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions');
    expect(Object.fromEntries(new Headers(calls[0]?.init?.headers).entries())).toEqual({
      'content-type': 'application/json',
      'x-extra': 'yes'
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      max_tokens: 20,
      response_format: { type: 'json_object' },
      seed: 4
    });
  });

  test('adds auth and tool_choice only with tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const provider = createOpenAiCompatibleProvider({
      id: 'p',
      baseUrl: 'https://example.test',
      apiKey: 'secret-key',
      fetch: fakeFetch(async (_url, init) => {
        headers.push(new Headers(init?.headers));
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(RESPONSE);
      })
    });
    await provider.chat({ model: 'm', messages: [] });
    await provider.chat({
      model: 'm',
      messages: [],
      tools: [{ name: 'walk', description: 'Walk', parameters: {} }],
      toolChoice: 'required'
    });
    expect(headers[0]?.get('authorization')).toBe('Bearer secret-key');
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
    expect(bodies[1]).toMatchObject({ tool_choice: 'required' });
  });

  test('retries 429 then succeeds, but does not retry 400', async () => {
    let attempts = 0;
    const retrying = createOpenAiCompatibleProvider({
      id: 'p', baseUrl: 'https://e', maxRetries: 1,
      fetch: fakeFetch(async () => ++attempts === 1
        ? new Response('busy', { status: 429 })
        : new Response(RESPONSE))
    });
    expect((await retrying.chat({ model: 'm', messages: [] })).message.content).toBe('ok');
    expect(attempts).toBe(2);

    attempts = 0;
    const noRetry = createOpenAiCompatibleProvider({
      id: 'p', baseUrl: 'https://e', maxRetries: 3,
      fetch: fakeFetch(async () => { attempts++; return new Response('bad', { status: 400 }); })
    });
    await expect(noRetry.chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(ModelHttpError);
    expect(attempts).toBe(1);
  });

  test('times out and never exposes the key in errors', async () => {
    const key = 'super-private-key';
    const provider = createOpenAiCompatibleProvider({
      id: 'p', baseUrl: 'https://e', apiKey: key, timeoutMs: 2, maxRetries: 0,
      fetch: fakeFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(`Bearer ${key}`)), { once: true });
      }))
    });
    try {
      await provider.chat({ model: 'm', messages: [] });
      throw new Error('expected timeout');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelHttpError);
      expect(String(error)).not.toContain(key);
      expect(String(error)).toContain('[REDACTED]');
    }
  });

  test('lists sorted model ids', async () => {
    const provider = createOpenAiCompatibleProvider({
      id: 'p', baseUrl: 'https://e',
      fetch: fakeFetch(async (url, init) => {
        expect(url).toBe('https://e/models');
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }] }));
      })
    });
    expect(await provider.listModels?.()).toEqual(['a', 'z']);
  });
});
