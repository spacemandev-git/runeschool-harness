import type { ChatMessage, ToolDefinition } from '../core/model.ts';
import type { TokenEstimator } from '../core/types.ts';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export const charEstimator: TokenEstimator = { estimate: estimateTokens };

export function estimateMessages(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[]
): number {
  let total = messages.length * 4;
  for (const message of messages) {
    total += estimateTokens(message.content ?? '');
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) total += estimateTokens(call.arguments);
    }
  }
  if (tools !== undefined) total += estimateTokens(JSON.stringify(tools));
  return total;
}
