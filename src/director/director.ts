import type { JsonValue } from '#protocol';
import type { HarnessBus, McpSession, ModelRegistry, PromptLibrary, RunConfig } from '../core/index.ts';
import { charEstimator } from '../models/index.ts';
import { createContextManager } from '../mind/contextManager.ts';
import type { Mailboxes } from '../runtime/mailbox.ts';
import {
  createHarnessTools, createMcpPassthroughTools, toolDefinitions,
  type DirectorTool, type RuntimeInternals
} from './tools.ts';

export interface Director {
  say(text: string): Promise<void>;
  notify(): void;
  transcript(): ReturnType<ReturnType<typeof createContextManager>['transcript']>;
  dispose(): void;
}

export interface DirectorDeps {
  readonly runtime: RuntimeInternals;
  readonly mcp: McpSession;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly bus: HarnessBus;
  readonly config: RunConfig;
  readonly mailboxes: Mailboxes;
  readonly autoWake: boolean;
}

function parseArgs(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object');
  return value as Record<string, unknown>;
}
function safe(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

export function createDirector(deps: DirectorDeps): Director {
  const tools: readonly DirectorTool[] = [
    ...createMcpPassthroughTools(deps.mcp),
    ...createHarnessTools(deps.runtime, deps.bus, deps.mailboxes, deps.models)
  ];
  const byName = new Map(tools.map((entry) => [entry.definition.name, entry]));
  const context = createContextManager({
    role: 'director', models: deps.models, estimator: charEstimator,
    budget: { maxPromptTokens: 24_000, compactAtTokens: 18_000, keepTurns: 6, recallLimit: 0 },
    bus: deps.bus, tools: toolDefinitions(tools),
    systemPrompt: () => deps.prompts.render('director-system', {
      run: JSON.stringify(deps.runtime.view.config()),
      world: JSON.stringify(deps.runtime.view.instance ?? deps.config.world),
      agents: deps.runtime.view.agents().map((agent) => `${agent.id}: ${agent.state}; ${agent.activity}; goal=${agent.goal ?? 'none'}`).join('\n') || 'none',
      teams: deps.runtime.view.teams().map((team) => `${team.id}: ${team.mission}; agents=${team.agents.join(',')}`).join('\n') || 'none',
      mcp_tools: deps.mcp.tools().map((tool) => `${tool.name} — ${tool.description ?? ''}`).join('\n') || 'none'
    })
  });
  const queued: { text: string; resolve: () => void; reject: (error: unknown) => void; auto: boolean }[] = [];
  let busy = false;
  let disposed = false;
  let pendingInbound: string[] = [];
  let autoQueued = false;

  function collectInbound(): void {
    pendingInbound.push(...deps.mailboxes.drain('director').map((message) => `[from ${message.from}] ${message.text}`));
  }

  async function turn(text: string): Promise<void> {
    collectInbound();
    const prefix = pendingInbound.splice(0);
    const user = [...prefix, text].filter(Boolean).join('\n');
    context.push({ role: 'user', content: user });
    let calls = 0;
    while (calls < 30 && !disposed) {
      const response = await deps.models.chat('director', {
        messages: context.messages(), tools: toolDefinitions(tools), toolChoice: 'auto'
      });
      context.push(response.message);
      deps.bus.emit('director.turn', { message: response.message, ...(response.usage === undefined ? {} : { usage: response.usage }) });
      const requested = response.message.toolCalls ?? [];
      if (requested.length === 0) break;
      for (const call of requested) {
        if (calls >= 30) break;
        calls++;
        const startedAt = Date.now();
        let result: JsonValue;
        let ok = false;
        try {
          const selected = byName.get(call.name);
          if (selected === undefined) throw new Error(`Unknown tool '${call.name}'`);
          result = await selected.run(parseArgs(call.arguments));
          ok = true;
        } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        context.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
        deps.bus.emit('director.tool', { call, result: safe(result), ok, durationMs: Date.now() - startedAt });
      }
    }
    if (calls >= 30) deps.bus.emit('log', { level: 'warn', scope: 'director', message: 'Director tool-call cap reached' });
    await context.maybeCompact();
  }

  async function pump(): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    while (queued.length > 0 && !disposed) {
      const job = queued.shift()!;
      if (job.auto) autoQueued = false;
      try { await turn(job.text); job.resolve(); } catch (error) {
        deps.bus.emit('log', { level: 'error', scope: 'director', message: error instanceof Error ? error.message : String(error) });
        job.reject(error);
      }
    }
    busy = false;
  }

  function enqueue(text: string, auto: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      queued.push({ text, resolve, reject, auto });
      void pump();
    });
  }

  const unsubscribeFinished = deps.bus.on('agent.finished', (event) => {
    pendingInbound.push(`[from ${event.data.agentId}] finished (${event.data.success ? 'success' : 'failure'}): ${event.data.summary}`);
    api.notify();
  });
  const api: Director = {
    say(text): Promise<void> { return enqueue(text, false); },
    notify(): void {
      collectInbound();
      if (!deps.autoWake || autoQueued || disposed) return;
      autoQueued = true;
      void enqueue('Update:', true).catch(() => {});
    },
    transcript: () => context.transcript(),
    dispose(): void { disposed = true; unsubscribeFinished(); }
  };
  return api;
}
