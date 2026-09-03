import type { JsonValue } from '#protocol';
import type { Admin, AdminFactory } from '../core/admin.ts';
import type { ChatMessage, ToolCall } from '../core/model.ts';
import { charEstimator } from '../models/index.ts';
import { createContextManager } from '../mind/contextManager.ts';
import { createAdminTools, toolDefinitions } from './tools.ts';

function parseArgs(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object');
  return value as Record<string, unknown>;
}

function safe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isErrorResult(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof (value as Readonly<Record<string, JsonValue>>).error === 'string';
}

function redactText(value: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0 ? value : value.replaceAll(secret, '[redacted]');
}

function redactedCall(call: ToolCall, secret: string | undefined): ToolCall {
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    const argumentsText = JSON.stringify(parsed, (key, value: unknown) => {
      if (key === 'admin_token') return undefined;
      return typeof value === 'string' ? redactText(value, secret) : value;
    });
    return { ...call, arguments: argumentsText };
  } catch {
    return { ...call, arguments: redactText(call.arguments, secret) };
  }
}

function redactedAssistant(message: Extract<ChatMessage, { role: 'assistant' }>, secret: string | undefined): Extract<ChatMessage, { role: 'assistant' }> {
  return {
    ...message,
    content: message.content === null ? null : redactText(message.content, secret),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => redactedCall(call, secret)) })
  };
}

export const createAdmin: AdminFactory = (deps) => {
  const tools = createAdminTools(deps);
  const definitions = toolDefinitions(tools);
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const context = createContextManager({
    role: 'admin',
    models: deps.models,
    estimator: charEstimator,
    budget: { maxPromptTokens: 20_000, compactAtTokens: 15_000, keepTurns: 6, recallLimit: 0 },
    bus: deps.bus,
    tools: definitions,
    systemPrompt: () => {
      const instance = deps.view.instance;
      const world = instance === undefined
        ? { instanceId: deps.world.instanceId, kind: deps.world.kind, httpUrl: deps.world.httpUrl, tick: 0 }
        : {
            instanceId: instance.id, kind: instance.kind, httpUrl: instance.httpUrl,
            ...(instance.watchUrl === undefined ? {} : { watchUrl: instance.watchUrl }), tick: instance.tick
          };
      const agents = deps.view.agents().map((agent) => {
        const at = agent.at === undefined ? 'unknown' : `${agent.at.x},${agent.at.z},${agent.at.level}`;
        const hp = agent.hp === undefined ? 'unknown' : `${agent.hp.current}/${agent.hp.max}`;
        return `${agent.id} (${agent.tag}, entity ${agent.entity}) ${agent.state} at ${at} hp ${hp} goal=${agent.goal ?? 'none'}`;
      }).join('\n') || 'none';
      return deps.prompts.render('admin-system', {
        run: JSON.stringify(deps.view.config()),
        world: JSON.stringify(world),
        agents,
        tools: definitions.map((tool) => `${tool.name} — ${tool.description}`).join('\n') || 'none'
      });
    }
  });
  const queued: { text: string; resolve: () => void; reject: (error: unknown) => void; auto: boolean }[] = [];
  let busy = false;
  let disposed = false;
  let pendingInbound: string[] = [];
  let autoQueued = false;

  function collectInbound(): number {
    const messages = deps.drainInbound();
    pendingInbound.push(...messages.map((message) => `[from ${message.from}] ${message.text}`));
    return messages.length;
  }

  async function turn(text: string): Promise<void> {
    collectInbound();
    const inbound = pendingInbound.splice(0);
    context.push({ role: 'user', content: [...inbound, text].filter(Boolean).join('\n') });
    let calls = 0;
    while (calls < 30 && !disposed) {
      const response = await deps.models.chat('admin', {
        messages: context.messages(), tools: definitions, toolChoice: 'auto'
      });
      const assistant = redactedAssistant(response.message, deps.world.adminToken);
      context.push(assistant);
      deps.bus.emit('admin.turn', {
        message: assistant,
        ...(response.usage === undefined ? {} : { usage: response.usage })
      });
      const requested = response.message.toolCalls ?? [];
      if (requested.length === 0) break;
      for (const call of requested) {
        if (calls >= 30 || disposed) break;
        calls++;
        const startedAt = Date.now();
        let result: JsonValue;
        let ok = false;
        try {
          const selected = byName.get(call.name);
          if (selected === undefined) throw new Error(`Unknown tool '${call.name}'`);
          result = await selected.run(parseArgs(call.arguments));
          ok = !isErrorResult(result);
        } catch (error) {
          result = { error: redactText(error instanceof Error ? error.message : String(error), deps.world.adminToken) };
        }
        context.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
        deps.bus.emit('admin.tool', {
          call: redactedCall(call, deps.world.adminToken), result: safe(result), ok, durationMs: Date.now() - startedAt
        });
      }
    }
    if (calls >= 30) deps.bus.emit('log', { level: 'warn', scope: 'admin', message: 'Admin tool-call cap reached' });
    await context.maybeCompact();
  }

  async function pump(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    while (queued.length > 0 && !disposed) {
      const job = queued.shift()!;
      if (job.auto) autoQueued = false;
      try {
        await turn(job.text);
        job.resolve();
      } catch (error) {
        deps.bus.emit('log', {
          level: 'error', scope: 'admin',
          message: redactText(error instanceof Error ? error.message : String(error), deps.world.adminToken)
        });
        job.reject(error);
      }
    }
    busy = false;
  }

  function enqueue(text: string, auto: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      queued.push({ text, resolve, reject, auto });
      void pump();
    });
  }

  const api: Admin = {
    say(text): Promise<void> { return enqueue(text, false); },
    notify(): void {
      const received = collectInbound();
      if (received === 0 || !deps.autoWake || autoQueued || disposed) return;
      autoQueued = true;
      void enqueue('Update:', true).catch(() => {});
    },
    transcript: () => context.transcript(),
    dispose(): void {
      disposed = true;
      for (const job of queued.splice(0)) job.resolve();
    }
  };
  return api;
};
