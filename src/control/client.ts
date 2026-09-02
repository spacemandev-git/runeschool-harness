import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import type {
  ControlClient,
  ControlClientMessage,
  ControlClientOptions,
  ControlDescriptor,
  ControlServerMessage,
  ControlSnapshot,
  ControlViewMethod,
} from '../core/control.ts';
import type { HarnessEvent, HarnessEventType } from '../core/bus.ts';
import type { LiveRuntimeCommands, RuntimeView } from '../core/runtime.ts';

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HOT_KEY_MS = 3_000;
const EVENT_REFRESH_DEBOUNCE_MS = 100;

interface PendingRequest {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly resolvesOnRemoteClose: boolean;
}

interface HotKey {
  readonly method: ControlViewMethod;
  readonly args: readonly JsonValue[];
  lastCalledAt: number;
}

type WithoutRequestId<T> = T extends { readonly id: string } ? Omit<T, 'id'> : never;
type ClientRequest = WithoutRequestId<ControlClientMessage>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeMessage(event: MessageEvent): unknown {
  if (typeof event.data === 'string') return JSON.parse(event.data);
  if (event.data instanceof ArrayBuffer) return JSON.parse(Buffer.from(event.data).toString('utf8'));
  if (ArrayBuffer.isView(event.data)) {
    return JSON.parse(Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8'));
  }
  return JSON.parse(String(event.data));
}

function cacheKey(method: ControlViewMethod, args: readonly JsonValue[]): string {
  return `${method}:${JSON.stringify(args)}`;
}

function fallbackFor(method: ControlViewMethod): undefined | readonly [] {
  return method === 'agentSnapshot' || method === 'agentReflexes' ? undefined : [];
}

export async function connectControl(
  descriptorOrSocketPath: ControlDescriptor | string,
  options: ControlClientOptions = {},
): Promise<ControlClient> {
  const path = typeof descriptorOrSocketPath === 'string' ? descriptorOrSocketPath : descriptorOrSocketPath.socketPath;
  const pollMs = options.pollMs ?? 500;
  const bus = createBus();
  const pending = new Map<string, PendingRequest>();
  const cache = new Map<string, unknown>();
  const hotKeys = new Map<string, HotKey>();
  const inFlight = new Set<string>();
  let requestSequence = 0;
  let latestSnapshot: ControlSnapshot | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let eventRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let localClose = false;
  let finished = false;
  let welcomed = false;
  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => { resolveClosed = resolve; });

  let socket: WebSocket;
  try {
    socket = new WebSocket(`ws+unix://${path}:/`);
  } catch {
    throw new Error(`no harness listening on ${path}`);
  }

  const stopTimers = (): void => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (eventRefreshTimer !== undefined) clearTimeout(eventRefreshTimer);
    pollTimer = undefined;
    eventRefreshTimer = undefined;
  };

  const settlePending = (reason: string, remote: boolean): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (remote && entry.resolvesOnRemoteClose) entry.resolve(null);
      else entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const finish = (reason: string, remote: boolean): void => {
    if (finished) return;
    finished = true;
    stopTimers();
    settlePending(reason, remote);
    resolveClosed(reason);
  };

  const request = (
    message: Extract<ClientRequest, { type: 'snapshot' | 'view' | 'command' }>,
    resolvesOnRemoteClose = false,
  ): Promise<JsonValue> => {
    if (finished || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('control connection is closed'));
    }
    const id = String(++requestSequence);
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`control request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { timer, resolve, reject, resolvesOnRemoteClose });
      try {
        socket.send(JSON.stringify({ ...message, id }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const refreshSnapshot = (): void => {
    const key = 'snapshot';
    if (finished || inFlight.has(key)) return;
    inFlight.add(key);
    void request({ type: 'snapshot' })
      .then((value) => {
        if (isRecord(value)) latestSnapshot = value as unknown as ControlSnapshot;
      })
      .catch(() => undefined)
      .finally(() => { inFlight.delete(key); });
  };

  const refreshKey = (key: string, hot: HotKey): void => {
    if (finished || inFlight.has(key)) return;
    inFlight.add(key);
    void request({ type: 'view', method: hot.method, args: hot.args })
      .then((value) => {
        const normalized = (hot.method === 'agentSnapshot' || hot.method === 'agentReflexes') && value === null
          ? undefined
          : value;
        cache.set(key, normalized);
      })
      .catch(() => undefined)
      .finally(() => { inFlight.delete(key); });
  };

  const refresh = (): void => {
    refreshSnapshot();
    const now = Date.now();
    for (const [key, hot] of hotKeys) {
      if (now - hot.lastCalledAt <= HOT_KEY_MS) refreshKey(key, hot);
      else hotKeys.delete(key);
    }
  };

  const scheduleEventRefresh = (): void => {
    if (finished) return;
    if (eventRefreshTimer !== undefined) clearTimeout(eventRefreshTimer);
    eventRefreshTimer = setTimeout(() => {
      eventRefreshTimer = undefined;
      refresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  };

  const cached = (method: ControlViewMethod, args: readonly JsonValue[]): unknown => {
    try {
      const key = cacheKey(method, args);
      const existing = hotKeys.get(key);
      if (existing === undefined) hotKeys.set(key, { method, args, lastCalledAt: Date.now() });
      else existing.lastCalledAt = Date.now();
      if (!cache.has(key)) queueMicrotask(() => {
        const hot = hotKeys.get(key);
        if (hot !== undefined) refreshKey(key, hot);
      });
      return cache.has(key) ? cache.get(key) : fallbackFor(method);
    } catch {
      return fallbackFor(method);
    }
  };

  const view: RuntimeView = {
    get runId() { return latestSnapshot?.runId ?? (typeof descriptorOrSocketPath === 'string' ? '' : descriptorOrSocketPath.runId); },
    get startedAt() { return latestSnapshot?.startedAt ?? (typeof descriptorOrSocketPath === 'string' ? 0 : descriptorOrSocketPath.startedAt); },
    get instance() { return latestSnapshot?.instance; },
    agents() { return latestSnapshot?.agents ?? []; },
    teams() { return latestSnapshot?.teams ?? []; },
    agentSnapshot(id) { return cached('agentSnapshot', [id]) as ReturnType<RuntimeView['agentSnapshot']>; },
    agentReflexes(id) { return cached('agentReflexes', [id]) as ReturnType<RuntimeView['agentReflexes']>; },
    agentTranscript(id) { return cached('agentTranscript', [id]) as ReturnType<RuntimeView['agentTranscript']>; },
    directorTranscript() { return cached('directorTranscript', []) as ReturnType<RuntimeView['directorTranscript']>; },
    adminTranscript() { return cached('adminTranscript', []) as ReturnType<RuntimeView['adminTranscript']>; },
    coordinatorTranscript(team) { return cached('coordinatorTranscript', [team]) as ReturnType<RuntimeView['coordinatorTranscript']>; },
    usage() { return latestSnapshot?.usage ?? []; },
    config() { return latestSnapshot?.config ?? null; },
  };

  const command = (method: Extract<ControlClientMessage, { type: 'command' }>['method'], args: readonly JsonValue[], stop = false): Promise<JsonValue> =>
    request({ type: 'command', method, args }, stop);

  const commands: LiveRuntimeCommands = {
    async directorSay(text) { await command('directorSay', [text]); },
    async adminSay(text) { await command('adminSay', [text]); },
    async agentSay(agentId, text) { await command('agentSay', [agentId, text]); },
    async coordinatorSay(team, text) { await command('coordinatorSay', [team, text]); },
    async setAgentGoal(agentId, goal) { await command('setAgentGoal', [agentId, goal]); },
    pauseAgent(agentId, reason, opts) {
      return command('pauseAgent', [agentId, reason ?? 'operator', opts === undefined ? null : opts as unknown as JsonValue]).then(() => undefined);
    },
    resumeAgent(agentId) { return command('resumeAgent', [agentId]).then(() => undefined); },
    async agentCommand(agentId, type, data) {
      return await command('agentCommand', [agentId, type, data as JsonValue]);
    },
    async spawnAgent(spec) { await command('spawnAgent', [spec as unknown as JsonValue]); },
    async removeAgent(agentId, reason) {
      const args: JsonValue[] = [agentId];
      if (reason !== undefined) args.push(reason);
      return await command('removeAgent', args) as unknown as { readonly removed: boolean };
    },
    setAgentModel(agentId, role, spec) {
      return command('setAgentModel', [agentId, role, spec as unknown as JsonValue]).then(() => undefined);
    },
    async createTeam(id, mission, agents) {
      await command('createTeam', [id, mission, agents as unknown as JsonValue]);
    },
    async stop(reason) { await command('stop', [reason], true); },
  };

  const client: ControlClient = {
    get descriptor() {
      if (typeof descriptorOrSocketPath !== 'string' && latestSnapshot === undefined) return descriptorOrSocketPath;
      return connectedDescriptor;
    },
    view,
    commands,
    bus,
    closed,
    async close(): Promise<void> {
      if (localClose || finished) return;
      localClose = true;
      finish('detached', false);
      try { socket.close(1000, 'detached'); } catch { /* already closed */ }
    },
  };

  let connectedDescriptor: ControlDescriptor = typeof descriptorOrSocketPath === 'string'
    ? { runId: '', pid: 0, socketPath: path, startedAt: 0, mcpUrl: '' }
    : descriptorOrSocketPath;

  const emitEvent = (event: HarnessEvent): void => {
    (bus.emit as (type: HarnessEventType, data: HarnessEvent['data']) => void)(event.type, event.data);
  };

  return await new Promise<ControlClient>((resolve, reject) => {
    let connectSettled = false;
    const unavailable = (): void => {
      if (connectSettled) return;
      connectSettled = true;
      clearTimeout(connectTimer);
      try { socket.close(); } catch { /* failed before opening */ }
      reject(new Error(`no harness listening on ${path}`));
    };
    const connectTimer = setTimeout(unavailable, CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ type: 'hello' } satisfies ControlClientMessage)); }
      catch { unavailable(); }
    });
    socket.addEventListener('error', () => {
      if (!welcomed) unavailable();
    });
    socket.addEventListener('close', () => {
      if (!welcomed) {
        unavailable();
        return;
      }
      if (!localClose) finish('connection lost', true);
    });
    socket.addEventListener('message', (event) => {
      let decoded: unknown;
      try { decoded = decodeMessage(event); }
      catch { return; }
      if (!isRecord(decoded) || typeof decoded.type !== 'string') return;
      const message = decoded as unknown as ControlServerMessage;

      if (message.type === 'welcome') {
        if (welcomed) return;
        welcomed = true;
        connectedDescriptor = message.descriptor;
        latestSnapshot = message.snapshot;
        clearTimeout(connectTimer);
        connectSettled = true;
        pollTimer = setInterval(refresh, Math.max(1, pollMs));
        resolve(client);
        return;
      }
      if (!welcomed) return;
      if (message.type === 'event') {
        emitEvent(message.event);
        scheduleEventRefresh();
      } else if (message.type === 'result') {
        const entry = pending.get(message.id);
        if (entry === undefined) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error));
      } else if (message.type === 'closing') {
        finish(message.reason, true);
      }
    });
  });
}
