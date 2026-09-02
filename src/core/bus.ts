/**
 * The harness event bus. Every module emits here; the TUI, the JSONL trace, and tests subscribe.
 * Payloads must be JSON-serialisable and free of credentials (the trace redacts defensively, but
 * do not rely on it).
 */
import type { JsonValue, SimEvent } from '#protocol';
import type { ActionOutcome } from './actions.ts';
import type { ChatMessage, ToolCall, Usage } from './model.ts';
import type { PerceptDelta, WorldSnapshot } from './percept.ts';
import type { ReflexEngineState } from './reflex.ts';
import type { AgentId, AgentState, ModelRole, RunId, TeamId, WakeReason } from './types.ts';

export interface HarnessEventMap {
  'run.start': { readonly runId: RunId; readonly config: JsonValue };
  'run.finish': { readonly runId: RunId; readonly summary: string; readonly ok: boolean };
  'run.error': { readonly error: string; readonly stack?: string };
  'log': { readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly scope: string; readonly message: string; readonly data?: JsonValue };

  'mcp.connected': { readonly url: string; readonly tools: readonly string[] };
  'mcp.tool': { readonly name: string; readonly arguments: JsonValue; readonly ok: boolean; readonly durationMs: number; readonly resultPreview: string };
  'world.provisioned': { readonly instanceId: string; readonly httpUrl: string; readonly wsUrl: string; readonly kind: 'scenario' | 'sandbox' | 'resumed' | 'attached'; readonly watchUrl?: string };

  'agent.spawned': {
    readonly agentId: AgentId; readonly tag: string; readonly entity: number; readonly team?: TeamId;
    readonly displayName: string; readonly persona?: string; readonly goal?: string; readonly privateGoal?: boolean;
  };
  'agent.removed': { readonly agentId: AgentId; readonly reason?: string };
  'agent.state': { readonly agentId: AgentId; readonly state: AgentState; readonly detail?: string };
  'agent.goal': { readonly agentId: AgentId; readonly goal: string; readonly from: 'director' | 'coordinator' | 'operator' | 'config' };
  'agent.snapshot': { readonly agentId: AgentId; readonly snapshot: WorldSnapshot };
  'agent.delta': { readonly agentId: AgentId; readonly delta: PerceptDelta };
  'agent.events': { readonly agentId: AgentId; readonly events: readonly SimEvent[] };
  'agent.action': { readonly agentId: AgentId; readonly outcome: ActionOutcome };
  'agent.reflex': { readonly agentId: AgentId; readonly line: string; readonly state: ReflexEngineState };
  'agent.mind.wake': { readonly agentId: AgentId; readonly reasons: readonly WakeReason[]; readonly note?: string };
  'agent.mind.turn': { readonly agentId: AgentId; readonly turn: number; readonly message: ChatMessage; readonly usage?: Usage };
  'agent.mind.tool': { readonly agentId: AgentId; readonly call: ToolCall; readonly result: JsonValue; readonly ok: boolean; readonly durationMs: number };
  'agent.mind.compact': { readonly agentId: AgentId; readonly droppedMessages: number; readonly summary: string };
  'agent.memory': { readonly agentId: AgentId; readonly op: 'remember' | 'recall' | 'forget'; readonly detail: string };
  'agent.message': { readonly from: AgentId | 'director' | 'admin' | 'operator' | `coordinator:${string}`; readonly to: AgentId | 'director' | 'admin' | `coordinator:${string}`; readonly text: string };
  'agent.finished': { readonly agentId: AgentId; readonly success: boolean; readonly summary: string };

  'team.created': { readonly teamId: TeamId; readonly agents: readonly AgentId[]; readonly mission: string };
  'team.report': { readonly teamId: TeamId; readonly text: string };
  'coordinator.turn': { readonly teamId: TeamId; readonly message: ChatMessage; readonly usage?: Usage };

  'director.turn': { readonly message: ChatMessage; readonly usage?: Usage };
  'director.tool': { readonly call: ToolCall; readonly result: JsonValue; readonly ok: boolean; readonly durationMs: number };

  'admin.turn': { readonly message: ChatMessage; readonly usage?: Usage };
  'admin.tool': { readonly call: ToolCall; readonly result: JsonValue; readonly ok: boolean; readonly durationMs: number };
  'admin.report': { readonly text: string };

  'model.request': {
    readonly role: ModelRole; readonly agentId?: AgentId; readonly model: string; readonly messages: number;
    readonly estimatedTokens: number;
    readonly content?: readonly { readonly role: string; readonly content: string; readonly name?: string }[];
  };
  'model.response': { readonly role: ModelRole; readonly agentId?: AgentId; readonly model: string; readonly usage?: Usage; readonly latencyMs: number; readonly ok: boolean; readonly error?: string };
}

export type HarnessEventType = keyof HarnessEventMap;

export type HarnessEvent = {
  [T in HarnessEventType]: { readonly type: T; readonly at: number; readonly seq: number; readonly data: HarnessEventMap[T] };
}[HarnessEventType];

export type HarnessListener<T extends HarnessEventType> = (event: Extract<HarnessEvent, { type: T }>) => void;

export interface HarnessBus {
  emit<T extends HarnessEventType>(type: T, data: HarnessEventMap[T]): void;
  on<T extends HarnessEventType>(type: T, listener: HarnessListener<T>): () => void;
  /** Subscribe to everything (trace, TUI raw pane). */
  onAny(listener: (event: HarnessEvent) => void): () => void;
  /** Last `limit` events, optionally filtered by type prefix (e.g. `agent.`). */
  history(options?: { readonly limit?: number; readonly prefix?: string }): readonly HarnessEvent[];
}
