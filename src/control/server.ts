import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JsonValue } from '#protocol';
import {
  CONTROL_COMMAND_METHODS,
  CONTROL_VIEW_METHODS,
  type ControlClientMessage,
  type ControlDescriptor,
  type ControlServer,
  type ControlServerMessage,
  type ControlServerOptions,
  type ControlSnapshot,
} from '../core/control.ts';
import { redactSecrets } from '../runtime/trace.ts';
import { descriptorPath, removeDescriptor, socketPath, writeDescriptor } from './descriptor.ts';

const MAX_OUTGOING_BYTES = 1024 * 1024;
const TRUNCATED_MARKER = '\n[truncated]';
const viewMethods = new Set<string>(CONTROL_VIEW_METHODS);
const commandMethods = new Set<string>(CONTROL_COMMAND_METHODS);

interface ClientState {
  welcomed: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonRoundTrip(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
}

function truncateUtf8(value: string, byteBudget: number): string {
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER);
  const contentBudget = Math.max(0, byteBudget - markerBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${TRUNCATED_MARKER}`;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

function encodeTruncated(text: string, build: (value: string) => Record<string, unknown>): string | undefined {
  let low = 0;
  let high = text.length;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(build(`${text.slice(0, middle)}${TRUNCATED_MARKER}`));
    if (Buffer.byteLength(candidate) <= MAX_OUTGOING_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function preserveBenignStrings(original: unknown, redacted: unknown): unknown {
  if (typeof original === 'string' && typeof redacted === 'string') {
    const containsRedaction = redacted.includes('[REDACTED]')
      || redacted.toUpperCase().includes('%5BREDACTED%5D');
    return containsRedaction ? redacted : original;
  }
  if (Array.isArray(original) && Array.isArray(redacted)) {
    return redacted.map((entry, index) => preserveBenignStrings(original[index], entry));
  }
  if (isRecord(original) && isRecord(redacted)) {
    return Object.fromEntries(Object.entries(redacted).map(([key, entry]) =>
      [key, preserveBenignStrings(original[key], entry)]));
  }
  return redacted;
}

/** Redact first, then ensure the encoded WebSocket frame never exceeds one MiB. */
function encodeOutgoing(message: ControlServerMessage): string {
  const redacted = preserveBenignStrings(message, redactSecrets(message)) as Record<string, unknown>;
  let encoded = JSON.stringify(redacted);
  if (Buffer.byteLength(encoded) <= MAX_OUTGOING_BYTES) return encoded;

  const type = redacted.type;
  if (type === 'result') {
    encoded = redacted.ok === true
      ? encodeTruncated(valueText(redacted.value), (value) => ({ ...redacted, value })) ?? encoded
      : encodeTruncated(String(redacted.error), (error) => ({ ...redacted, error })) ?? encoded;
  } else if (type === 'event') {
    const event = redacted.event as Record<string, unknown>;
    encoded = encodeTruncated(valueText(event.data), (data) => ({
      ...redacted, event: { ...event, data },
    })) ?? encoded;
  } else if (type === 'welcome') {
    const snapshot = redacted.snapshot as Record<string, unknown>;
    const snapshotText = valueText(snapshot);
    encoded = encodeTruncated(snapshotText, (config) => ({
      ...redacted,
      snapshot: {
        runId: snapshot.runId,
        startedAt: snapshot.startedAt,
        ...(snapshot.instance === undefined ? {} : { instance: snapshot.instance }),
        agents: [],
        teams: [],
        usage: [],
        config,
      },
    })) ?? encoded;
  } else if (type === 'closing') {
    encoded = encodeTruncated(String(redacted.reason), (reason) => ({ ...redacted, reason })) ?? encoded;
  }

  if (Buffer.byteLength(encoded) <= MAX_OUTGOING_BYTES) return encoded;
  return JSON.stringify({ type: 'closing', reason: 'outgoing payload exceeded 1 MiB [truncated]' });
}

function decodeMessage(message: string | BufferSource): unknown {
  if (typeof message === 'string') return JSON.parse(message);
  if (message instanceof ArrayBuffer) return JSON.parse(Buffer.from(message).toString('utf8'));
  return JSON.parse(Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function createControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const nextSocketPath = socketPath(options.logDir, options.runId);
  const nextDescriptorPath = descriptorPath(options.logDir, options.runId);
  const instance = options.view.instance;
  const descriptor: ControlDescriptor = {
    runId: options.runId,
    pid: process.pid,
    socketPath: nextSocketPath,
    startedAt: options.view.startedAt,
    mcpUrl: options.mcpUrl,
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    ...(instance === undefined ? {} : { instanceId: instance.id }),
  };

  const snapshot = (): ControlSnapshot => {
    const currentInstance = options.view.instance;
    return {
      runId: options.view.runId,
      startedAt: options.view.startedAt,
      ...(currentInstance === undefined ? {} : { instance: currentInstance }),
      agents: options.view.agents(),
      teams: options.view.teams(),
      usage: options.view.usage(),
      config: options.view.config(),
    };
  };

  await mkdir(dirname(nextSocketPath), { recursive: true });
  await unlink(nextSocketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });

  const clients = new Set<Bun.ServerWebSocket<ClientState>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let unsubscribeBus = (): void => undefined;

  const send = (socket: Bun.ServerWebSocket<ClientState>, message: ControlServerMessage): void => {
    try {
      socket.send(encodeOutgoing(message));
    } catch {
      // The close handler removes dead peers. A run must not fail because an attached client left.
    }
  };

  const server = Bun.serve<ClientState>({
    unix: nextSocketPath,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request, { data: { welcomed: false } })) return undefined;
      return new Response('WebSocket upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        clients.add(socket);
      },
      async message(socket, rawMessage) {
        let decoded: unknown;
        try {
          decoded = decodeMessage(rawMessage);
        } catch {
          socket.close(1008, 'invalid control message');
          return;
        }
        if (!isRecord(decoded) || typeof decoded.type !== 'string') {
          socket.close(1008, 'invalid control message');
          return;
        }

        if (!socket.data.welcomed) {
          if (decoded.type !== 'hello') {
            socket.close(1008, 'hello required');
            return;
          }
          const sinceSeq = decoded.sinceSeq === undefined ? 0 : decoded.sinceSeq;
          if (typeof sinceSeq !== 'number' || !Number.isFinite(sinceSeq)) {
            socket.close(1008, 'invalid hello');
            return;
          }
          socket.data.welcomed = true;
          send(socket, { type: 'welcome', descriptor, snapshot: snapshot() });
          for (const event of options.bus.history({ limit: options.replayLimit ?? 1_000 })) {
            if (event.seq > sinceSeq) send(socket, { type: 'event', event });
          }
          return;
        }

        if (decoded.type === 'ping') {
          send(socket, { type: 'pong' });
          return;
        }
        if (decoded.type === 'hello') {
          socket.close(1008, 'duplicate hello');
          return;
        }

        const id = decoded.id;
        if (typeof id !== 'string') {
          socket.close(1008, 'request id required');
          return;
        }
        try {
          let value: JsonValue;
          if (decoded.type === 'snapshot') {
            value = jsonRoundTrip(snapshot());
          } else if (decoded.type === 'view') {
            if (typeof decoded.method !== 'string' || !viewMethods.has(decoded.method)) {
              throw new Error(`unknown view method: ${String(decoded.method)}`);
            }
            if (!Array.isArray(decoded.args)) throw new Error('view args must be an array');
            const method = options.view[decoded.method as (typeof CONTROL_VIEW_METHODS)[number]] as unknown as (...args: JsonValue[]) => unknown;
            value = jsonRoundTrip(method.apply(options.view, decoded.args as JsonValue[]));
          } else if (decoded.type === 'command') {
            if (typeof decoded.method !== 'string' || !commandMethods.has(decoded.method)) {
              throw new Error(`unknown command method: ${String(decoded.method)}`);
            }
            if (!Array.isArray(decoded.args)) throw new Error('command args must be an array');
            const method = options.commands[decoded.method as (typeof CONTROL_COMMAND_METHODS)[number]] as unknown as (...args: JsonValue[]) => unknown;
            value = jsonRoundTrip(await method.apply(options.commands, decoded.args as JsonValue[]));
          } else {
            throw new Error(`unknown control message: ${decoded.type}`);
          }
          send(socket, { type: 'result', id, ok: true, value });
        } catch (error) {
          send(socket, { type: 'result', id, ok: false, error: errorMessage(error) });
        }
      },
      close(socket) {
        clients.delete(socket);
      },
    },
  });

  const close = (reason = 'run closed'): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    closePromise = (async () => {
      unsubscribeBus();
      for (const socket of clients) {
        send(socket, { type: 'closing', reason });
        const redactedReason = redactSecrets(reason);
        const safeReason = typeof redactedReason === 'string' ? redactedReason : 'run closed';
        const closeReason = Buffer.byteLength(safeReason) <= 123 ? safeReason : truncateUtf8(safeReason, 123);
        try { socket.close(1001, closeReason); } catch { /* already closed */ }
      }
      clients.clear();
      // Bun 1.3 can leave the stop promise pending for Unix-socket WebSockets even after the
      // listening socket is stopped. Initiating the forced stop is synchronous; cleanup below is
      // the completion boundary exposed by ControlServer.close().
      void server.stop(true).catch(() => undefined);
      await unlink(nextSocketPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await removeDescriptor(nextDescriptorPath);
    })();
    return closePromise;
  };

  unsubscribeBus = options.bus.onAny((event) => {
    if (closing) return;
    for (const socket of clients) {
      if (socket.data.welcomed) send(socket, { type: 'event', event });
    }
    if (event.type === 'run.finish') queueMicrotask(() => { void close(); });
  });

  try {
    await chmod(nextSocketPath, 0o600);
    await writeDescriptor(nextDescriptorPath, descriptor);
  } catch (error) {
    unsubscribeBus();
    void server.stop(true).catch(() => undefined);
    await unlink(nextSocketPath).catch(() => undefined);
    await removeDescriptor(nextDescriptorPath);
    throw error;
  }

  return {
    socketPath: nextSocketPath,
    descriptorPath: nextDescriptorPath,
    descriptor,
    close,
  };
}
