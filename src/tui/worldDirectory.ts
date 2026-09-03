import type { JsonValue } from '#protocol';

export interface BackendInstanceSummary {
  readonly id: string;
  readonly tick: number;
  readonly state: string;
  readonly entityCount: number;
  readonly realtime: boolean;
  readonly kind: string;
  readonly pvp: boolean;
}

export interface BackendScenarioSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface WorldDirectory {
  readonly backendUrl: string;
  listInstances(): Promise<readonly BackendInstanceSummary[]>;
  listScenarios(): Promise<readonly BackendScenarioSummary[]>;
  connect(instanceId: string): Promise<BackendInstanceSummary>;
  spawnScenario(scenarioId: string): Promise<BackendInstanceSummary>;
  spawnSandbox(request: Readonly<Record<string, JsonValue>>): Promise<BackendInstanceSummary>;
  close(): Promise<void>;
}

interface McpResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MCP_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function instanceSummary(value: unknown): BackendInstanceSummary {
  const entry = record(value);
  if (entry === undefined) throw new Error('backend returned an invalid instance');
  return {
    id: requiredString(entry.id, 'instance.id'),
    tick: finiteNumber(entry.tick),
    state: typeof entry.state === 'string' ? entry.state : 'unknown',
    entityCount: finiteNumber(entry.entityCount),
    realtime: entry.realtime === true,
    kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
    pvp: entry.pvp === true,
  };
}

function scenarioSummary(value: unknown): BackendScenarioSummary {
  const entry = record(value);
  if (entry === undefined) throw new Error('backend returned an invalid scenario');
  const meta = record(entry.meta);
  const id = requiredString(entry.id ?? meta?.id, 'scenario.id');
  const name = typeof meta?.name === 'string' && meta.name.trim().length > 0 ? meta.name : id;
  const description = typeof meta?.description === 'string' && meta.description.trim().length > 0
    ? meta.description
    : undefined;
  return { id, name, ...(description === undefined ? {} : { description }) };
}

function safeMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function jsonBody(value: unknown, label: string): unknown {
  if (value === undefined) throw new Error(`${label} returned no JSON`);
  return value;
}

function toolText(result: unknown): string {
  const envelope = record(result);
  const content = Array.isArray(envelope?.content) ? envelope.content : [];
  return content
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== undefined && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

function parseToolValue(result: unknown): unknown {
  const envelope = record(result);
  const text = toolText(result);
  if (envelope?.isError === true) throw new Error(text.length > 0 ? text : 'RuneSchool tool call failed');
  if (text.length === 0) return envelope?.structuredContent ?? null;
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

function findInstanceId(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof value === 'string') return /\binst-[A-Za-z0-9_-]+\b/.exec(value)?.[0];
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findInstanceId(item, seen);
      if (id !== undefined) return id;
    }
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  for (const key of ['instanceId', 'instance_id', 'id']) {
    const candidate = entry[key];
    if (typeof candidate === 'string' && /^inst-[A-Za-z0-9_-]+$/.test(candidate)) return candidate;
  }
  for (const item of Object.values(entry)) {
    const id = findInstanceId(item, seen);
    if (id !== undefined) return id;
  }
  return undefined;
}

export function createRuneSchoolWorldDirectory(
  backendUrl: string,
  options: { readonly fetch?: Fetcher } = {},
): WorldDirectory {
  const baseUrl = backendUrl.trim().replace(/\/+$/, '');
  if (baseUrl.length === 0) throw new Error('RuneSchool backend URL is empty');
  const fetcher = options.fetch ?? fetch;
  const mcpUrl = `${baseUrl}/mcp`;
  let sessionId: string | undefined;
  let rpcId = 0;
  let closed = false;

  const requestJson = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`RuneSchool backend unavailable at ${baseUrl}: ${safeMessage(error)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`RuneSchool backend ${response.status}: ${text.slice(0, 500) || response.statusText}`);
    try { return jsonBody(JSON.parse(text) as unknown, path); }
    catch (error) { throw new Error(`RuneSchool backend returned invalid JSON for ${path}: ${safeMessage(error)}`); }
  };

  const postMcp = async (payload: Readonly<Record<string, unknown>>, includeSession = true): Promise<McpResponse> => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };
    if (includeSession && sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    let response: Response;
    try {
      response = await fetcher(mcpUrl, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`RuneSchool MCP unavailable at ${mcpUrl}: ${safeMessage(error)}`);
    }
    if (!includeSession) sessionId = response.headers.get('mcp-session-id') ?? undefined;
    const text = await response.text();
    if (!response.ok) throw new Error(`RuneSchool MCP ${response.status}: ${text.slice(0, 500) || response.statusText}`);
    if (text.trim().length === 0) return {};
    let decoded: McpResponse;
    try { decoded = JSON.parse(text) as McpResponse; }
    catch (error) { throw new Error(`RuneSchool MCP returned invalid JSON: ${safeMessage(error)}`); }
    if (decoded.error !== undefined) throw new Error(decoded.error.message ?? `RuneSchool MCP error ${decoded.error.code ?? 'unknown'}`);
    return decoded;
  };

  const ensureMcp = async (): Promise<void> => {
    if (closed) throw new Error('RuneSchool world directory is closed');
    if (sessionId !== undefined) return;
    const initialized = await postMcp({
      jsonrpc: '2.0', id: ++rpcId, method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: '@runeschool/harness-cockpit', version: '0.1.0' },
      },
    }, false);
    if (initialized.result === undefined || sessionId === undefined) throw new Error('RuneSchool MCP did not establish a session');
    await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };

  const callTool = async (name: string, args: Readonly<Record<string, JsonValue>>): Promise<unknown> => {
    await ensureMcp();
    const response = await postMcp({
      jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args },
    });
    return parseToolValue(response.result);
  };

  const getInstance = async (instanceId: string): Promise<BackendInstanceSummary> => {
    const id = requiredString(instanceId, 'instance id');
    return instanceSummary(await requestJson(`/instances/${encodeURIComponent(id)}`));
  };

  const spawnedInstance = async (tool: string, args: Readonly<Record<string, JsonValue>>): Promise<BackendInstanceSummary> => {
    const value = await callTool(tool, args);
    const instanceId = findInstanceId(value);
    if (instanceId === undefined) throw new Error(`${tool} succeeded but returned no instance id`);
    return await getInstance(instanceId);
  };

  return {
    backendUrl: baseUrl,
    async listInstances() {
      const value = await requestJson('/instances');
      if (!Array.isArray(value)) throw new Error('RuneSchool backend returned an invalid instance list');
      return value.map(instanceSummary);
    },
    async listScenarios() {
      const value = await requestJson('/scenarios');
      if (!Array.isArray(value)) throw new Error('RuneSchool backend returned an invalid scenario list');
      return value.map(scenarioSummary);
    },
    connect: getInstance,
    async spawnScenario(scenarioId) {
      return await spawnedInstance('start_scenario', { scenario_id: requiredString(scenarioId, 'scenario id'), realtime: true });
    },
    async spawnSandbox(request) {
      return await spawnedInstance('create_sandbox_world', request);
    },
    async close() {
      if (closed) return;
      closed = true;
      const activeSession = sessionId;
      sessionId = undefined;
      if (activeSession === undefined) return;
      try {
        await fetcher(mcpUrl, {
          method: 'DELETE',
          headers: { 'mcp-session-id': activeSession, 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Session cleanup is best-effort; the server expires abandoned sessions.
      }
    },
  };
}
