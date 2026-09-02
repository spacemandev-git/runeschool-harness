import { readFileSync } from 'node:fs';
import type { JsonValue } from '#protocol';
import type { ModelConfig, ModelSpec } from '../core/model.ts';
import type { ModelRole } from '../core/types.ts';

const ROLES = ['director', 'admin', 'coordinator', 'agent', 'summarizer'] as const satisfies readonly ModelRole[];
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|credential/i;
const ROLE_ENV: Readonly<Record<ModelRole, string>> = {
  director: 'HARNESS_MODEL_DIRECTOR',
  admin: 'HARNESS_MODEL_ADMIN',
  coordinator: 'HARNESS_MODEL_COORDINATOR',
  agent: 'HARNESS_MODEL_AGENT',
  summarizer: 'HARNESS_MODEL_SUMMARIZER',
};

export class ModelConfigError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ModelConfigError';
  }
}

type Env = Record<string, string | undefined>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function parseEnvSpec(value: string, path: string): ModelSpec {
  // `provider:model` selects a provider explicitly; a bare slug (which may itself contain `/`,
  // e.g. `openai/gpt-5.5-pro` on Nous Portal) is a model on the default provider.
  const colon = value.indexOf(':');
  if (colon < 0) return { provider: 'nous', model: value };
  if (colon === 0 || colon === value.length - 1) {
    throw new ModelConfigError(path, 'must be provider:model or a bare model slug');
  }
  return { provider: value.slice(0, colon), model: value.slice(colon + 1) };
}

function defaults(env: Env): ModelConfig {
  const provider = 'nous';
  const nousApiKeyEnv = env.NOUS_API_KEY !== undefined && env.NOUS_API_KEY.length > 0
    ? 'NOUS_API_KEY'
    : env.NOUS_KEY !== undefined && env.NOUS_KEY.length > 0
      ? 'NOUS_KEY'
      : 'NOUS_API_KEY';
  const defaultSpec: ModelSpec = {
    provider,
    model: env.NOUS_MODEL ?? 'openai/gpt-5.5-pro'
  };
  const roles = {} as Mutable<Record<ModelRole, ModelSpec>>;
  for (const role of ROLES) {
    const override = env[ROLE_ENV[role]];
    roles[role] = override === undefined || override.length === 0
      ? { ...defaultSpec }
      : parseEnvSpec(override, ROLE_ENV[role]);
  }
  return {
    providers: {
      nous: {
        kind: 'openai-compatible',
        baseUrl: env.NOUS_BASE_URL ?? 'https://inference-api.nousresearch.com/v1',
        apiKeyEnv: nousApiKeyEnv
      },
      openrouter: {
        kind: 'openai-compatible',
        baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OR_KEY'
      }
    },
    roles
  };
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = defaults(process.env);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelConfigError(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ModelConfigError(`${path}.${key}`, 'is not allowed');
  }
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new ModelConfigError(path, 'must be a non-empty string');
  }
}

function optionalNumber(value: unknown, path: string, integer = false): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)
    || (integer && !Number.isInteger(value)))) {
    throw new ModelConfigError(path, integer ? 'must be a finite integer' : 'must be a finite number');
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

function validateSpec(value: unknown, path: string, partial: boolean): void {
  const spec = record(value, path);
  knownKeys(spec, ['provider', 'model', 'temperature', 'maxTokens', 'extra'], path);
  optionalString(spec.provider, `${path}.provider`);
  optionalString(spec.model, `${path}.model`);
  if (!partial && spec.provider === undefined) throw new ModelConfigError(`${path}.provider`, 'is required');
  if (!partial && spec.model === undefined) throw new ModelConfigError(`${path}.model`, 'is required');
  optionalNumber(spec.temperature, `${path}.temperature`);
  optionalNumber(spec.maxTokens, `${path}.maxTokens`, true);
  if (typeof spec.maxTokens === 'number' && spec.maxTokens <= 0) {
    throw new ModelConfigError(`${path}.maxTokens`, 'must be greater than zero');
  }
  if (spec.extra !== undefined && (!recordOrFalse(spec.extra) || !isJsonValue(spec.extra))) {
    throw new ModelConfigError(`${path}.extra`, 'must be a JSON object');
  }
}

function recordOrFalse(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePatch(value: unknown): Record<string, unknown> {
  const root = record(value, '$');
  knownKeys(root, ['providers', 'roles', 'agents'], '$');
  if (root.providers !== undefined) {
    const providers = record(root.providers, 'providers');
    for (const [id, raw] of Object.entries(providers)) {
      if (id.length === 0) throw new ModelConfigError('providers', 'provider ids must be non-empty');
      const provider = record(raw, `providers.${id}`);
      knownKeys(provider, ['kind', 'baseUrl', 'apiKeyEnv', 'headers', 'headerEnv', 'timeoutMs', 'maxRetries'], `providers.${id}`);
      if (provider.kind !== undefined && provider.kind !== 'openai-compatible' && provider.kind !== 'mock') {
        throw new ModelConfigError(`providers.${id}.kind`, 'must be openai-compatible or mock');
      }
      optionalString(provider.baseUrl, `providers.${id}.baseUrl`);
      optionalString(provider.apiKeyEnv, `providers.${id}.apiKeyEnv`);
      optionalNumber(provider.timeoutMs, `providers.${id}.timeoutMs`, true);
      optionalNumber(provider.maxRetries, `providers.${id}.maxRetries`, true);
      if (typeof provider.timeoutMs === 'number' && provider.timeoutMs <= 0) {
        throw new ModelConfigError(`providers.${id}.timeoutMs`, 'must be greater than zero');
      }
      if (typeof provider.maxRetries === 'number' && provider.maxRetries < 0) {
        throw new ModelConfigError(`providers.${id}.maxRetries`, 'must not be negative');
      }
      if (provider.headers !== undefined) {
        const headers = record(provider.headers, `providers.${id}.headers`);
        for (const [name, header] of Object.entries(headers)) {
          if (typeof header !== 'string') throw new ModelConfigError(`providers.${id}.headers.${name}`, 'must be a string');
          if (SENSITIVE_HEADER.test(name)) {
            throw new ModelConfigError(`providers.${id}.headers.${name}`, 'may contain a credential; use apiKeyEnv or headerEnv');
          }
        }
      }
      if (provider.headerEnv !== undefined) {
        const headers = record(provider.headerEnv, `providers.${id}.headerEnv`);
        for (const [name, envName] of Object.entries(headers)) {
          if (name.length === 0) throw new ModelConfigError(`providers.${id}.headerEnv`, 'header names must be non-empty');
          optionalString(envName, `providers.${id}.headerEnv.${name}`);
        }
      }
    }
  }
  if (root.roles !== undefined) {
    const roles = record(root.roles, 'roles');
    knownKeys(roles, ROLES, 'roles');
    for (const [role, spec] of Object.entries(roles)) validateSpec(spec, `roles.${role}`, true);
  }
  if (root.agents !== undefined) {
    const agents = record(root.agents, 'agents');
    for (const [agentId, rawRoles] of Object.entries(agents)) {
      const roles = record(rawRoles, `agents.${agentId}`);
      knownKeys(roles, ROLES, `agents.${agentId}`);
      for (const [role, spec] of Object.entries(roles)) validateSpec(spec, `agents.${agentId}.${role}`, true);
    }
  }
  return root;
}

function mergeSpec(base: ModelSpec | undefined, patch: Record<string, unknown>): ModelSpec {
  const next = { ...base, ...patch } as unknown as ModelSpec;
  if (base?.extra !== undefined && recordOrFalse(patch.extra)) {
    return { ...next, extra: { ...base.extra, ...patch.extra } as Readonly<Record<string, JsonValue>> };
  }
  return next;
}

function mergeConfig(base: ModelConfig, patch: Record<string, unknown>): ModelConfig {
  const providers: Record<string, ModelConfig['providers'][string]> = { ...base.providers };
  if (recordOrFalse(patch.providers)) {
    for (const [id, raw] of Object.entries(patch.providers)) {
      const providerPatch = raw as Record<string, unknown>;
      const existing = providers[id];
      providers[id] = {
        ...existing,
        ...providerPatch,
        ...(existing?.headers !== undefined && recordOrFalse(providerPatch.headers)
          ? { headers: { ...existing.headers, ...providerPatch.headers } as Record<string, string> }
          : {}),
        ...(existing?.headerEnv !== undefined && recordOrFalse(providerPatch.headerEnv)
          ? { headerEnv: { ...existing.headerEnv, ...providerPatch.headerEnv } as Record<string, string> }
          : {})
      } as ModelConfig['providers'][string];
    }
  }
  const roles = { ...base.roles } as Mutable<Record<ModelRole, ModelSpec>>;
  if (recordOrFalse(patch.roles)) {
    for (const role of ROLES) {
      const rolePatch = patch.roles[role];
      if (recordOrFalse(rolePatch)) roles[role] = mergeSpec(roles[role], rolePatch);
    }
  }
  const agents: Record<string, Partial<Record<ModelRole, Partial<ModelSpec>>>> = { ...base.agents };
  if (recordOrFalse(patch.agents)) {
    for (const [agentId, rawRoles] of Object.entries(patch.agents)) {
      const current = { ...agents[agentId] };
      const agentRoles = rawRoles as Record<string, unknown>;
      for (const role of ROLES) {
        const rolePatch = agentRoles[role];
        if (recordOrFalse(rolePatch)) current[role] = mergeSpec(current[role] as ModelSpec | undefined, rolePatch);
      }
      agents[agentId] = current;
    }
  }
  return { providers, roles, ...(Object.keys(agents).length === 0 ? {} : { agents }) };
}

function validateComplete(config: ModelConfig): void {
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.kind !== 'openai-compatible' && provider.kind !== 'mock') {
      throw new ModelConfigError(`providers.${id}.kind`, 'is required');
    }
    if (provider.kind === 'openai-compatible' && provider.baseUrl === undefined) {
      throw new ModelConfigError(`providers.${id}.baseUrl`, 'is required for openai-compatible providers');
    }
  }
  for (const role of ROLES) {
    const spec = config.roles[role];
    validateSpec(spec, `roles.${role}`, false);
    if (config.providers[spec.provider] === undefined) {
      throw new ModelConfigError(`roles.${role}.provider`, `references unknown provider ${spec.provider}`);
    }
  }
  for (const [agentId, roles] of Object.entries(config.agents ?? {})) {
    for (const role of ROLES) {
      const spec = roles[role];
      if (spec?.provider !== undefined && config.providers[spec.provider] === undefined) {
        throw new ModelConfigError(`agents.${agentId}.${role}.provider`, `references unknown provider ${spec.provider}`);
      }
    }
  }
}

export function loadModelConfig(path?: string, env: Env = process.env): ModelConfig {
  const base = defaults(env);
  if (path === undefined) {
    validateComplete(base);
    return base;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ModelConfigError('$', error instanceof Error ? error.message : String(error));
  }
  const config = mergeConfig(base, validatePatch(parsed));
  validateComplete(config);
  return config;
}
