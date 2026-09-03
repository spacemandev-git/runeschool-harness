import type { JsonValue } from '#protocol';
import type { HarnessBus } from '../core/bus.ts';
import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ModelProvider,
  ModelRegistry,
  ModelSpec,
  ResolvedModel,
  Usage,
  UsageByKey
} from '../core/model.ts';
import type { AgentId, ModelRole, TokenEstimator } from '../core/types.ts';
import { createMockProvider } from './mock.ts';
import { createOpenAiCompatibleProvider } from './openaiCompatible.ts';
import { charEstimator } from './tokens.ts';

export class ModelResolveError extends Error {
  constructor(role: ModelRole, agentId: AgentId | undefined, provider: string | undefined, detail: string) {
    super(`Could not resolve model role ${role}${agentId === undefined ? '' : ` for agent ${agentId}`}`
      + `${provider === undefined ? '' : ` with provider ${provider}`}: ${detail}`);
    this.name = 'ModelResolveError';
  }
}

export class ModelAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelAuthError';
  }
}

interface RegistryDeps {
  readonly bus: HarnessBus;
  readonly env?: Record<string, string | undefined>;
  readonly providers?: Readonly<Record<string, ModelProvider>>;
  readonly estimator?: TokenEstimator;
  readonly now?: () => number;
}

interface MutableUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errors: number;
}

function mergedSpec(...specs: readonly (Partial<ModelSpec> | undefined)[]): ModelSpec | undefined {
  let result: Partial<ModelSpec> | undefined;
  for (const spec of specs) {
    if (spec === undefined) continue;
    result = {
      ...result,
      ...spec,
      ...(result?.extra !== undefined && spec.extra !== undefined
        ? { extra: { ...result.extra, ...spec.extra } }
        : {})
    };
  }
  if (result?.provider === undefined || result.model === undefined) return undefined;
  return result as ModelSpec;
}

function estimateRequest(request: Omit<ChatRequest, 'model'>, estimator: TokenEstimator): number {
  let total = request.messages.length * 4;
  for (const message of request.messages) {
    total += estimator.estimate(message.content ?? '');
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) total += estimator.estimate(call.arguments);
    }
  }
  if (request.tools !== undefined) total += estimator.estimate(JSON.stringify(request.tools));
  return total;
}

function printableError(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

export function createModelRegistry(config: ModelConfig, deps: RegistryDeps): ModelRegistry {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const estimator = deps.estimator ?? charEstimator;
  const instances = new Map<string, ModelProvider>();
  const missingAuth = new Map<string, string>();
  const secrets: string[] = [];

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const injected = deps.providers?.[id];
    if (injected !== undefined) {
      instances.set(id, injected);
      continue;
    }
    if (providerConfig.kind === 'mock') {
      instances.set(id, createMockProvider({ id }));
      continue;
    }
    if (providerConfig.kind === 'openai-compatible') {
      if (providerConfig.baseUrl === undefined) continue;
      const apiKey = providerConfig.apiKeyEnv === undefined ? undefined : env[providerConfig.apiKeyEnv];
      const missing = providerConfig.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)
        ? [providerConfig.apiKeyEnv]
        : [];
      const environmentHeaders: Record<string, string> = {};
      for (const [header, envName] of Object.entries(providerConfig.headerEnv ?? {})) {
        const value = env[envName];
        if (value === undefined || value.length === 0) missing.push(envName);
        else {
          environmentHeaders[header] = value;
          secrets.push(value);
        }
      }
      if (missing.length > 0) missingAuth.set(id, missing.join(', '));
      if (apiKey !== undefined && apiKey.length > 0) secrets.push(apiKey);
      instances.set(id, createOpenAiCompatibleProvider({
        id,
        baseUrl: providerConfig.baseUrl,
        ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
        ...((providerConfig.headers === undefined && Object.keys(environmentHeaders).length === 0)
          ? {}
          : { headers: { ...providerConfig.headers, ...environmentHeaders } }),
        ...(providerConfig.timeoutMs === undefined ? {} : { timeoutMs: providerConfig.timeoutMs }),
        ...(providerConfig.maxRetries === undefined ? {} : { maxRetries: providerConfig.maxRetries }),
        now
      }));
    }
  }

  const roleOverrides = new Map<ModelRole, Partial<ModelSpec>>();
  const overrides = new Map<AgentId, Map<ModelRole, Partial<ModelSpec>>>();
  const totals = new Map<string, MutableUsage>();

  function resolve(role: ModelRole, agentId?: AgentId): ResolvedModel {
    const roleSpec = config.roles[role];
    const roleOverride = roleOverrides.get(role);
    const agentSpec = agentId === undefined ? undefined : config.agents?.[agentId]?.[role];
    const runtimeSpec = agentId === undefined ? undefined : overrides.get(agentId)?.get(role);
    const spec = mergedSpec(roleSpec, roleOverride, agentSpec, runtimeSpec);
    if (spec === undefined) {
      throw new ModelResolveError(role, agentId, runtimeSpec?.provider ?? agentSpec?.provider ?? roleSpec?.provider, 'provider or model is missing');
    }
    const providerInstance = instances.get(spec.provider);
    if (providerInstance === undefined) {
      throw new ModelResolveError(role, agentId, spec.provider, 'provider is not configured');
    }
    return { ...spec, providerInstance, role, ...(agentId === undefined ? {} : { agentId }) };
  }

  function keys(role: ModelRole, agentId: AgentId | undefined, model: string): readonly string[] {
    return [role, ...(agentId === undefined ? [] : [`${role}:${agentId}`]), `model:${model}`];
  }

  function account(accountKeys: readonly string[], usage: Usage | undefined, error: boolean): void {
    for (const key of accountKeys) {
      const value = totals.get(key) ?? {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        errors: 0
      };
      value.calls++;
      if (error) value.errors++;
      if (usage !== undefined) {
        value.promptTokens += usage.promptTokens;
        value.completionTokens += usage.completionTokens;
        value.totalTokens += usage.totalTokens;
      }
      totals.set(key, value);
    }
  }

  async function chat(
    role: ModelRole,
    request: Omit<ChatRequest, 'model'> & { readonly model?: string },
    options: { readonly agentId?: AgentId; readonly signal?: AbortSignal } = {}
  ): Promise<ChatResponse> {
    const resolved = resolve(role, options.agentId);
    const effective: ChatRequest = {
      ...request,
      model: request.model ?? resolved.model,
      temperature: request.temperature ?? resolved.temperature,
      maxTokens: request.maxTokens ?? resolved.maxTokens,
      extra: request.extra ?? resolved.extra
    };
    const accountKeys = keys(role, options.agentId, effective.model);
    deps.bus.emit('model.request', {
      role,
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      model: effective.model,
      messages: effective.messages.length,
      estimatedTokens: estimateRequest(effective, estimator)
    });
    const startedAt = now();
    try {
      const authEnv = missingAuth.get(resolved.provider);
      if (authEnv !== undefined) throw new ModelAuthError(`${authEnv} ${authEnv.includes(',') ? 'are' : 'is'} not set`);
      const response = await resolved.providerInstance.chat(effective, options.signal);
      account(accountKeys, response.usage, false);
      deps.bus.emit('model.response', {
        role,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        model: effective.model,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        latencyMs: response.latencyMs,
        ok: true
      });
      return response;
    } catch (error) {
      account(accountKeys, undefined, true);
      deps.bus.emit('model.response', {
        role,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        model: effective.model,
        latencyMs: Math.max(0, now() - startedAt),
        ok: false,
        error: printableError(error, secrets)
      });
      throw error;
    }
  }

  return {
    resolve,
    setRoleOverride(role, spec): void {
      roleOverrides.set(role, spec);
    },
    clearRoleOverride(role): void {
      roleOverrides.delete(role);
    },
    setOverride(agentId, role, spec): void {
      const byRole = overrides.get(agentId) ?? new Map<ModelRole, Partial<ModelSpec>>();
      byRole.set(role, spec);
      overrides.set(agentId, byRole);
    },
    clearOverride(agentId, role): void {
      if (role === undefined) {
        overrides.delete(agentId);
        return;
      }
      const byRole = overrides.get(agentId);
      byRole?.delete(role);
      if (byRole?.size === 0) overrides.delete(agentId);
    },
    chat,
    usage(): readonly UsageByKey[] {
      return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
        key,
        calls: value.calls,
        usage: {
          promptTokens: value.promptTokens,
          completionTokens: value.completionTokens,
          totalTokens: value.totalTokens
        },
        errors: value.errors
      }));
    },
    providers(): readonly ModelProvider[] {
      return [...instances.values()];
    }
  };
}
