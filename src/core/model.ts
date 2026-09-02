/**
 * Model contracts. Every LLM call in the harness goes through a {@link ModelProvider} resolved by
 * the {@link ModelRegistry} for a role (and optionally a specific agent). The wire shape is the
 * OpenAI chat-completions dialect because Nous Portal speaks it; other providers adapt to it.
 */
import type { JsonValue } from '#protocol';
import type { AgentId, ModelRole } from './types.ts';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object. */
  readonly parameters: JsonValue;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as returned by the model; parse defensively. */
  readonly arguments: string;
}

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string; readonly name?: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json';
  /** Free-form provider extras (e.g. reasoning effort). */
  readonly extra?: Readonly<Record<string, JsonValue>>;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChatResponse {
  readonly message: Extract<ChatMessage, { role: 'assistant' }>;
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';
  readonly usage?: Usage;
  readonly latencyMs: number;
  readonly model: string;
  readonly raw?: JsonValue;
}

export interface ModelProvider {
  readonly id: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** Optional: list model slugs the provider can serve. */
  listModels?(): Promise<readonly string[]>;
}

export interface ModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly extra?: Readonly<Record<string, JsonValue>>;
}

export interface ResolvedModel extends ModelSpec {
  readonly providerInstance: ModelProvider;
  readonly role: ModelRole;
  readonly agentId?: AgentId;
}

export interface UsageByKey {
  readonly key: string; // `${role}` or `${role}:${agentId}` or `model:${slug}`
  readonly calls: number;
  readonly usage: Usage;
  readonly errors: number;
}

export interface ModelRegistry {
  /** Role default, overridable per agent. Throws if no provider is configured. */
  resolve(role: ModelRole, agentId?: AgentId): ResolvedModel;
  setOverride(agentId: AgentId, role: ModelRole, spec: Partial<ModelSpec>): void;
  clearOverride(agentId: AgentId, role?: ModelRole): void;
  /** Convenience: resolve + call + account usage + emit `model.request`/`model.response` on the bus. */
  chat(role: ModelRole, request: Omit<ChatRequest, 'model'> & { readonly model?: string }, options?: { readonly agentId?: AgentId; readonly signal?: AbortSignal }): Promise<ChatResponse>;
  usage(): readonly UsageByKey[];
  providers(): readonly ModelProvider[];
}

/** Configuration file / CLI shape for the registry. */
export interface ModelConfig {
  readonly providers: Readonly<Record<string, {
    readonly kind: 'openai-compatible' | 'mock';
    readonly baseUrl?: string;
    /** Name of the environment variable holding the key — never the key itself. */
    readonly apiKeyEnv?: string;
    /** Non-sensitive static headers only. Secret-bearing headers are rejected by validation. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Header name to environment-variable name, for credentials that are not bearer tokens. */
    readonly headerEnv?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
  }>>;
  readonly roles: Readonly<Record<ModelRole, ModelSpec>>;
  readonly agents?: Readonly<Record<AgentId, Partial<Record<ModelRole, Partial<ModelSpec>>>>>;
}
