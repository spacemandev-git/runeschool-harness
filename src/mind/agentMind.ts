import type { JsonValue } from '#protocol';
import type { Mind, MindDeps } from '../core/agent.ts';
import type { ChatMessage, ToolCall } from '../core/model.ts';
import type { AgentState, WakeReason } from '../core/types.ts';
import { charEstimator } from '../models/tokens.ts';
import { renderDeltaLines, renderSnapshot } from '../format.ts';
import { createContextManager } from './contextManager.ts';
import { buildDigest, type DigestMemory } from './digest.ts';
import { buildSystemPrompt } from './promptBuilder.ts';
import { salientReasons } from './salience.ts';
import { createAgentTools, toToolDefinitions, type AgentTool } from './tools.ts';
import { createWakePolicy } from './wakePolicy.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isErrorResult(result: JsonValue): boolean {
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    && typeof (result as Readonly<Record<string, JsonValue>>).error === 'string';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface AgentMindOptions {
  readonly extraTools?: readonly AgentTool[];
}

export function createAgentMind(deps: MindDeps, options: AgentMindOptions = {}): Mind {
  let goal = deps.spec.goal?.trim() ?? '';
  let paused = false;
  let finished = false;
  let disposed = false;
  let endedWake = false;
  let firstWakeAfterGoal = goal.length > 0;
  let lastCheckpoint = deps.view.checkpoint();
  let wakeCheckpoint = lastCheckpoint;
  let blindResumePending = false;
  let cachedSystemPrompt = '';
  let lastWakeAt: number | undefined;
  let lastReasons: readonly WakeReason[] = [];
  let modelTurn = 0;
  let activeRun: Promise<void> | undefined;
  let wakePolicy: ReturnType<typeof createWakePolicy> | undefined;
  const abort = new AbortController();
  const injectedByWake: Set<number>[] = [];
  const directInbox: { from: string; text: string; at: number }[] = [];
  const busMessageNotifications: { from: string; text: string }[] = [];

  const setState = (next: AgentState, detail?: string): void => {
    deps.setState(next, detail);
  };

  const rebuildSystemPrompt = (): void => {
    cachedSystemPrompt = buildSystemPrompt(deps, { goal, ...(deps.spec.team === undefined ? {} : { team: deps.spec.team }) });
  };
  rebuildSystemPrompt();

  const toolContext = {
    endWake(): void { endedWake = true; },
    finish(success: boolean, summary: string): void {
      if (finished) return;
      finished = true;
      wakePolicy?.setActive(false);
      deps.onFinished(success, summary);
    },
    getWakeCheckpoint(): number { return wakeCheckpoint; },
    setWakeCheckpoint(checkpoint: number): void { wakeCheckpoint = checkpoint; },
    reflexChanged(): void { rebuildSystemPrompt(); }
  };
  const tools = [...createAgentTools(deps, toolContext), ...(options.extraTools ?? [])];
  const toolDefinitions = toToolDefinitions(tools);
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const context = createContextManager({
    role: 'agent',
    agentId: deps.agentId,
    models: deps.models,
    estimator: charEstimator,
    budget: deps.context,
    bus: deps.bus,
    memory: deps.memory,
    systemPrompt: () => cachedSystemPrompt,
    tools: toolDefinitions
  });

  async function recallMemories(): Promise<DigestMemory[]> {
    const snapshot = deps.view.snapshot();
    const nearbyNames = [...new Set(snapshot.nearby.map((entry) => entry.name).filter((name): name is string => name !== undefined))];
    const query = [goal, ...nearbyNames].join(' ').trim();
    const excluded = new Set(injectedByWake.flatMap((set) => [...set]));
    try {
      const hits = await deps.memory.recall({ text: query, limit: deps.context.recallLimit });
      return hits.filter((hit) => !excluded.has(hit.record.id)).map((hit) => ({
        id: hit.record.id,
        kind: hit.record.kind,
        text: hit.record.text
      }));
    } catch (error) {
      deps.bus.emit('log', {
        level: 'warn',
        scope: `mind.${deps.agentId}.memory`,
        message: `Memory recall failed: ${messageOf(error)}`
      });
      return [];
    }
  }

  async function executeTool(call: ToolCall): Promise<JsonValue> {
    const tool = toolsByName.get(call.name);
    if (tool === undefined) return { error: `Unknown tool '${call.name}'` };
    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.arguments);
    } catch (error) {
      return { error: messageOf(error) };
    }
    try {
      return await tool.run(args);
    } catch (error) {
      return { error: messageOf(error) };
    }
  }

  async function executeTurn(reasons: readonly WakeReason[], note?: string): Promise<void> {
    if (disposed || finished || paused || goal.length === 0 && !reasons.includes('operator') && !reasons.includes('message')) return;
    endedWake = false;
    lastWakeAt = Date.now();
    lastReasons = [...reasons];
    setState('thinking');
    deps.bus.emit('agent.mind.wake', {
      agentId: deps.agentId,
      reasons,
      ...(note === undefined ? {} : { note })
    });

    const snapshot = deps.view.snapshot();
    wakeCheckpoint = deps.view.checkpoint();
    if (blindResumePending) {
      lastCheckpoint = deps.view.checkpoint();
      blindResumePending = false;
    }
    const delta = deps.view.deltaSince(lastCheckpoint);
    const memories = await recallMemories();
    const mailboxMessages = [...directInbox.splice(0), ...deps.mailbox.drain()];
    context.push({
      role: 'user',
      content: buildDigest({
        reasons,
        snapshot,
        messages: mailboxMessages,
        deltaLines: renderDeltaLines(delta, (kind, id) => deps.view.nameOf(kind, id)),
        memories,
        ...(note === undefined ? {} : { note }),
        ...(firstWakeAfterGoal ? { fullObservation: renderSnapshot(snapshot) } : {}),
        ...(deps.reflexes.state().behaviour === undefined ? {} : { behaviour: deps.reflexes.state().behaviour })
      })
    });
    firstWakeAfterGoal = false;
    injectedByWake.push(new Set(memories.map((memory) => memory.id)));
    if (injectedByWake.length > 3) injectedByWake.shift();

    let toolCallsUsed = 0;
    let chatFailed = false;
    try {
      while (!endedWake && !finished && toolCallsUsed < deps.wake.maxToolCallsPerWake) {
        let response;
        try {
          response = await deps.models.chat('agent', {
            messages: context.messages(),
            tools: toolDefinitions,
            toolChoice: 'auto'
          }, { agentId: deps.agentId, signal: abort.signal });
        } catch (error) {
          chatFailed = true;
          deps.bus.emit('log', {
            level: 'error',
            scope: `mind.${deps.agentId}.model`,
            message: `Agent chat failed: ${messageOf(error)}`
          });
          break;
        }
        context.push(response.message);
        deps.bus.emit('agent.mind.turn', {
          agentId: deps.agentId,
          turn: ++modelTurn,
          message: response.message,
          ...(response.usage === undefined ? {} : { usage: response.usage })
        });
        const calls = response.message.toolCalls ?? [];
        if (calls.length === 0) break;
        for (const call of calls) {
          if (endedWake || finished || toolCallsUsed >= deps.wake.maxToolCallsPerWake) break;
          toolCallsUsed++;
          const startedAt = Date.now();
          const result = await executeTool(call);
          context.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
          deps.bus.emit('agent.mind.tool', {
            agentId: deps.agentId,
            call,
            result,
            ok: !isErrorResult(result),
            durationMs: Math.max(0, Date.now() - startedAt)
          });
        }
      }
    } catch (error) {
      deps.bus.emit('log', {
        level: 'error',
        scope: `mind.${deps.agentId}`,
        message: `Mind turn failed: ${messageOf(error)}`
      });
    } finally {
      lastCheckpoint = deps.view.checkpoint();
      try {
        await context.maybeCompact();
      } catch (error) {
        deps.bus.emit('log', {
          level: 'warn',
          scope: `mind.${deps.agentId}.context`,
          message: `Context compaction failed: ${messageOf(error)}`
        });
      }
      if (!finished) setState(deps.reflexes.state().behaviour === undefined ? 'idle' : 'acting');
      if (chatFailed) await delay(deps.wake.minIntervalMs * 4, abort.signal);
    }
  }

  wakePolicy = createWakePolicy(deps.wake, {
    now: Date.now,
    setTimeout: (callback, timeout) => setTimeout(callback, timeout),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    run: async (reasons, note) => {
      const promise = executeTurn(reasons, note);
      activeRun = promise;
      try { await promise; } finally { if (activeRun === promise) activeRun = undefined; }
    },
    bus: deps.bus,
    agentId: deps.agentId
  });

  const unsubscribers = [
    deps.bus.on('agent.delta', (event) => {
      if (event.data.agentId !== deps.agentId || disposed || finished || paused) return;
      const reasons = salientReasons(event.data.delta, deps.wake);
      for (const reason of reasons) void wakePolicy?.request(reason);
    }),
    deps.bus.on('agent.message', (event) => {
      if (event.data.to !== deps.agentId || disposed || finished || paused) return;
      const notification = { from: event.data.from, text: event.data.text };
      busMessageNotifications.push(notification);
      queueMicrotask(() => {
        const index = busMessageNotifications.indexOf(notification);
        if (index >= 0) busMessageNotifications.splice(index, 1);
      });
      void wakePolicy?.request('message');
    }),
    deps.bus.on('agent.reflex', (event) => {
      if (event.data.agentId === deps.agentId) rebuildSystemPrompt();
    }),
    deps.bus.on('agent.state', (event) => {
      if (event.data.agentId !== deps.agentId || finished || disposed) return;
      if (event.data.state === 'paused') {
        paused = true;
        wakePolicy?.setActive(false);
      } else if (event.data.state === 'idle' || event.data.state === 'acting') {
        paused = false;
        wakePolicy?.setActive(goal.length > 0);
      }
    })
  ];

  // `spec.goal` seeds the system prompt only; the runtime announces it through `setGoal(goal,
  // 'config')` after the link and world model are up, which schedules the first wake exactly once.

  return {
    wake(reason, note): Promise<void> {
      if (disposed || finished) return Promise.resolve();
      if (reason === 'resumed') {
        paused = false;
        if (note === 'resumed (blind)') blindResumePending = true;
        wakePolicy?.setActive(goal.length > 0);
      } else if (paused) return Promise.resolve();
      return wakePolicy?.request(reason, note) ?? Promise.resolve();
    },
    async setGoal(nextGoal, from): Promise<void> {
      if (disposed || finished) return;
      goal = nextGoal.trim();
      firstWakeAfterGoal = true;
      rebuildSystemPrompt();
      deps.bus.emit('agent.goal', { agentId: deps.agentId, goal, from });
      wakePolicy?.setActive(goal.length > 0 && !paused);
      if (goal.length > 0 && !paused) await wakePolicy?.request('goal-assigned');
    },
    async say(from, text): Promise<void> {
      if (disposed || finished) return;
      const notified = busMessageNotifications.findIndex((message) => message.from === from && message.text === text);
      if (notified >= 0) {
        busMessageNotifications.splice(notified, 1);
        return;
      }
      if (deps.mailbox.pending() === 0) directInbox.push({ from, text, at: Date.now() });
      if (paused) return;
      await wakePolicy?.request('message');
    },
    status() {
      const stats = context.stats();
      return {
        turns: wakePolicy?.turns ?? 0,
        ...(lastWakeAt === undefined ? {} : { lastWakeAt }),
        lastReasons,
        promptTokensEstimate: stats.promptTokensEstimate,
        historyMessages: stats.historyMessages,
        compactions: stats.compactions,
        busy: wakePolicy?.busy ?? false
      };
    },
    transcript(): readonly ChatMessage[] {
      return context.transcript();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      wakePolicy?.setActive(false);
      wakePolicy?.dispose();
      for (const unsubscribe of unsubscribers) unsubscribe();
      abort.abort(new Error('Mind disposed'));
      await activeRun;
    }
  };
}
