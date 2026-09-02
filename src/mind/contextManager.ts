import type { ContextBudget } from '../core/agent.ts';
import type { HarnessBus } from '../core/bus.ts';
import type { MemoryStore } from '../core/memory.ts';
import type { ChatMessage, ModelRegistry, ToolDefinition } from '../core/model.ts';
import type { ModelRole, TokenEstimator } from '../core/types.ts';

export interface ContextManagerOptions {
  readonly role: ModelRole;
  readonly agentId?: string;
  readonly models: ModelRegistry;
  readonly estimator: TokenEstimator;
  readonly budget: ContextBudget;
  readonly bus: HarnessBus;
  readonly memory?: MemoryStore;
  readonly systemPrompt: () => string;
  readonly tools?: readonly ToolDefinition[];
}

export interface ContextStats {
  readonly promptTokensEstimate: number;
  readonly historyMessages: number;
  readonly compactions: number;
}

export interface ContextManager {
  push(message: ChatMessage): void;
  messages(): ChatMessage[];
  transcript(): readonly ChatMessage[];
  maybeCompact(): Promise<void>;
  stats(): ContextStats;
}

function estimate(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[] | undefined,
  estimator: TokenEstimator
): number {
  let total = messages.length * 4;
  for (const message of messages) {
    total += estimator.estimate(message.content ?? '');
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) total += estimator.estimate(call.arguments);
    }
  }
  if (tools !== undefined) total += estimator.estimate(JSON.stringify(tools));
  return total;
}

function splitTurns(history: readonly ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const message of history) {
    if (message.role === 'user' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1]!.push(message);
  }
  return turns;
}

function renderDropped(messages: readonly ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const calls = (message.toolCalls ?? []).map((call) => `${call.name}(${call.arguments})`).join(', ');
      return `assistant: ${message.content ?? ''}${calls.length === 0 ? '' : ` [tools: ${calls}]`}`;
    }
    if (message.role === 'tool') return `tool ${message.toolCallId}: ${message.content}`;
    return `${message.role}: ${message.content}`;
  }).join('\n');
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
  let history: ChatMessage[] = [];
  let compactions = 0;

  function messages(): ChatMessage[] {
    return [{ role: 'system', content: options.systemPrompt() }, ...history];
  }

  function stats(): ContextStats {
    return {
      promptTokensEstimate: estimate(messages(), options.tools, options.estimator),
      historyMessages: messages().length,
      compactions
    };
  }

  return {
    push(message): void {
      if (message.role === 'system') return;
      history.push(message.role === 'tool' && message.content.length > 2_000
        ? { ...message, content: message.content.slice(0, 2_000) }
        : message);
    },
    messages,
    transcript(): readonly ChatMessage[] {
      return messages();
    },
    async maybeCompact(): Promise<void> {
      if (estimate(messages(), options.tools, options.estimator) <= options.budget.compactAtTokens) return;
      const turns = splitTurns(history);
      const keepCount = Math.max(0, Math.floor(options.budget.keepTurns));
      const splitAt = Math.max(0, turns.length - keepCount);
      if (splitAt === 0) return;
      const dropped = turns.slice(0, splitAt).flat();
      const kept = turns.slice(splitAt).flat();
      let summary = '';
      try {
        const response = await options.models.chat('summarizer', {
          messages: [
            {
              role: 'system',
              content: 'Summarise what this agent did, learned, and still intends to do. Facts only. Use at most 200 words.'
            },
            { role: 'user', content: renderDropped(dropped) }
          ],
          toolChoice: 'none',
          maxTokens: 300
        }, options.agentId === undefined ? undefined : { agentId: options.agentId });
        summary = response.message.content?.trim() ?? '';
        if (summary.length === 0) throw new Error('Summarizer returned an empty summary');
        if (options.memory !== undefined) {
          try {
            await options.memory.remember({ kind: 'journal', text: summary.slice(0, 2_000), importance: 0.4 });
          } catch (error) {
            options.bus.emit('log', {
              level: 'warn',
              scope: options.agentId === undefined ? `${options.role}.context` : `${options.role}.${options.agentId}.context`,
              message: `Could not write journal memory: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
        history = [{ role: 'user', content: `Summary of earlier activity:\n${summary}` }, ...kept];
      } catch (error) {
        history = kept;
        options.bus.emit('log', {
          level: 'warn',
          scope: options.agentId === undefined ? `${options.role}.context` : `${options.role}.${options.agentId}.context`,
          message: `Context summarization failed; dropped oldest turns: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      compactions++;
      options.bus.emit('agent.mind.compact', {
        agentId: options.agentId ?? options.role,
        droppedMessages: dropped.length,
        summary
      });
    },
    stats
  };
}
