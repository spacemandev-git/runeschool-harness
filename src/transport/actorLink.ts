import {
  ACTOR_COMMAND_TYPES,
  ADMIN_COMMAND_TYPES,
  type CommandResult,
  type JsonValue,
  type ServerEvent
} from '#protocol';
import { AGENT_DENIED_COMMANDS } from '../core/actions.ts';
import type {
  ActionIntent,
  ActionOutcome,
  ActorCredentials,
  ActorLink,
  HarnessBus,
  LinkState
} from '../core/index.ts';

export interface ActorLinkOptions {
  readonly ringSize?: number;
  readonly commandTimeoutMs?: number;
  readonly agentId?: string;
  readonly maxCommandsPerSecond?: number;
  /** Internal test seam. */
  readonly webSocketFactory?: (url: string) => WebSocket;
  /** Internal test seam. */
  readonly fetch?: typeof fetch;
  /** Internal test seam. */
  readonly now?: () => number;
}

export class LinkHttpError extends Error {
  constructor(readonly status: number, readonly body: JsonValue) {
    super(`LinkHttpError(${status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'LinkHttpError';
  }
}

interface PendingCommand {
  readonly resolve: (result: CommandResult) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface QueueEntry {
  readonly run: () => void;
  readonly closed: () => void;
}

interface SentResult {
  readonly result: CommandResult;
  readonly sentAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommandResult(value: unknown): value is CommandResult {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.ok === 'boolean'
    && typeof value.tick === 'number';
}

function isServerEvent(value: unknown): value is ServerEvent {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.seq === 'number'
    && typeof value.tick === 'number'
    && 'data' in value;
}

function jsonBody(text: string): JsonValue {
  try { return JSON.parse(text) as JsonValue; } catch { return text; }
}

function invalidOutcome(intent: ActionIntent, tick: number, now: () => number): ActionOutcome {
  return {
    intent,
    ok: false,
    code: 'invalid_command',
    message: `Unsupported actor command '${intent.type}'`,
    tick,
    sentAt: now()
  };
}

function deniedOutcome(intent: ActionIntent, tick: number, now: () => number): ActionOutcome {
  return {
    intent,
    ok: false,
    code: 'denied_command',
    message: `Agent command '${intent.type}' is denied by the harness`,
    tick,
    sentAt: now()
  };
}

export function createActorLink(
  credentials: ActorCredentials,
  bus: HarnessBus,
  options: ActorLinkOptions = {}
): ActorLink {
  const ringSize = Math.max(1, Math.floor(options.ringSize ?? 4_096));
  const timeoutMs = Math.max(1, Math.floor(options.commandTimeoutMs ?? 10_000));
  const rate = Math.max(1, Math.floor(options.maxCommandsPerSecond ?? 32));
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? fetch;
  const socketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  const eventListeners = new Set<(event: ServerEvent) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  const pending = new Map<string, PendingCommand>();
  const events: ServerEvent[] = [];
  const commandTypes: ReadonlySet<string> = new Set(ACTOR_COMMAND_TYPES);
  const deniedCommandTypes: ReadonlySet<string> = new Set(AGENT_DENIED_COMMANDS);
  const adminCommandTypes: ReadonlySet<string> = new Set(ADMIN_COMMAND_TYPES);
  const queue: QueueEntry[] = [];
  let state: LinkState = 'closed';
  let socket: WebSocket | undefined;
  let sequence = 0;
  let lastSeq = 0;
  let lastTick = 0;
  let closeReasonDelivered = false;
  let closePromise: Promise<void> | undefined;
  let tokens = rate;
  let refilledAt = now();
  let rateTimer: ReturnType<typeof setTimeout> | undefined;

  function log(level: 'debug' | 'warn' | 'error', message: string, data?: JsonValue): void {
    bus.emit('log', { level, scope: `actor-link:${credentials.tag}`, message, ...(data === undefined ? {} : { data }) });
  }

  function deliverClose(reason: string): void {
    if (closeReasonDelivered) return;
    closeReasonDelivered = true;
    for (const listener of closeListeners) listener(reason);
  }

  function closedResult(id: string, error: 'link_closed' | 'timeout', message: string): CommandResult {
    return { id, ok: false, error, message, tick: lastTick };
  }

  function settlePending(error: 'link_closed' | 'timeout', message: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.resolve(closedResult(id, error, message));
    }
    pending.clear();
  }

  function flushQueue(): void {
    if (rateTimer !== undefined) clearTimeout(rateTimer);
    rateTimer = undefined;
    for (const entry of queue.splice(0)) entry.closed();
  }

  function refill(): void {
    const time = now();
    const elapsed = Math.max(0, time - refilledAt);
    tokens = Math.min(rate, tokens + elapsed * rate / 1_000);
    refilledAt = time;
  }

  function pumpQueue(): void {
    if (state !== 'open') {
      if (state === 'closed' || state === 'failed') flushQueue();
      return;
    }
    refill();
    while (queue.length > 0 && tokens >= 1) {
      tokens -= 1;
      queue.shift()!.run();
      refill();
    }
    if (queue.length > 0 && rateTimer === undefined) {
      const delay = Math.max(1, Math.ceil((1 - tokens) * 1_000 / rate));
      rateTimer = setTimeout(() => {
        rateTimer = undefined;
        pumpQueue();
      }, delay);
    }
  }

  function appendEvent(event: ServerEvent): void {
    events.push(event);
    if (events.length > ringSize) events.splice(0, events.length - ringSize);
    lastSeq = Math.max(lastSeq, event.seq);
    lastTick = Math.max(lastTick, event.tick);
    for (const listener of eventListeners) listener(event);
  }

  function receive(raw: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as unknown;
    } catch (error) {
      log('warn', 'Ignored invalid WebSocket JSON', {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (isCommandResult(frame)) {
      lastTick = Math.max(lastTick, frame.tick);
      const entry = pending.get(frame.id);
      if (entry !== undefined) {
        clearTimeout(entry.timeout);
        pending.delete(frame.id);
        entry.resolve(frame);
      }
      return;
    }
    if (isRecord(frame) && frame.type === 'event-batch' && Array.isArray(frame.events)) {
      for (const candidate of frame.events) if (isServerEvent(candidate)) appendEvent(candidate);
      return;
    }
    if (isRecord(frame) && frame.type === 'interest-set') return;
    if (isServerEvent(frame)) appendEvent(frame);
  }

  function sendDirect(type: string, data: Readonly<Record<string, unknown>>): Promise<SentResult> {
    const active = socket;
    const id = `a-${++sequence}`;
    const sentAt = now();
    if (active === undefined || active.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        result: closedResult(id, 'link_closed', 'Actor link is closed'),
        sentAt
      });
    }
    const command = { type, instance: credentials.instanceId, id, data };
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve({
          result: closedResult(id, 'timeout', `Timed out waiting for command acknowledgement: ${id}`),
          sentAt
        });
      }, timeoutMs);
      pending.set(id, {
        timeout,
        resolve: (result) => resolve({ result, sentAt })
      });
      try {
        active.send(JSON.stringify(command));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        log('warn', 'WebSocket send failed', {
          error: error instanceof Error ? error.message : String(error),
          command: type
        });
        resolve({
          result: closedResult(id, 'link_closed', 'Actor link closed while sending'),
          sentAt
        });
      }
    });
  }

  function queuedSend(type: string, data: Readonly<Record<string, unknown>>): Promise<SentResult> {
    if (state !== 'open') {
      const id = `a-${sequence + 1}`;
      return Promise.resolve({
        result: closedResult(id, 'link_closed', 'Actor link is closed'),
        sentAt: now()
      });
    }
    return new Promise((resolve) => {
      queue.push({
        run: () => { void sendDirect(type, data).then(resolve); },
        closed: () => resolve({
          result: closedResult(`a-${sequence + 1}`, 'link_closed', 'Actor link is closed'),
          sentAt: now()
        })
      });
      pumpQueue();
    });
  }

  function fail(reason: string): void {
    if (state === 'closed' || state === 'failed') return;
    state = 'failed';
    settlePending('link_closed', reason);
    flushQueue();
    deliverClose(reason);
  }

  const link: ActorLink = {
    credentials,
    get state(): LinkState { return state; },
    get lastSeq(): number { return lastSeq; },
    get lastTick(): number { return lastTick; },
    async connect(): Promise<void> {
      if (state === 'open') return;
      if (state === 'connecting') throw new Error('Actor link is already connecting');
      state = 'connecting';
      closeReasonDelivered = false;
      const separator = credentials.wsUrl.includes('?') ? '&' : '?';
      const wsUrl = `${credentials.wsUrl}${separator}since=0`;
      const active = socketFactory(wsUrl);
      socket = active;
      // Retained events may arrive immediately after upgrade, so message is registered first.
      active.addEventListener('message', (event) => receive(event.data));
      active.addEventListener('error', () => {
        if (state === 'open') fail('Actor WebSocket failed');
      });
      active.addEventListener('close', (event) => {
        const reason = event.reason || `Actor WebSocket closed (${event.code})`;
        if (state === 'connecting') fail(reason);
        else if (state === 'open') {
          state = 'closed';
          settlePending('link_closed', reason);
          flushQueue();
          deliverClose(reason);
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const opened = (): void => { cleanup(); resolve(); };
          const failed = (): void => { cleanup(); reject(new Error(`Failed to open actor WebSocket: ${wsUrl}`)); };
          const cleanup = (): void => {
            active.removeEventListener('open', opened);
            active.removeEventListener('error', failed);
            active.removeEventListener('close', failed);
          };
          active.addEventListener('open', opened);
          active.addEventListener('error', failed);
          active.addEventListener('close', failed);
        });
        const claim = await sendDirect('claim', { token: credentials.token });
        const result = claim.result as CommandResult & { readonly role?: unknown; readonly entity?: unknown };
        const valid = result.ok
          && (result.role === 'admin' || (result.role === 'actor' && result.entity === credentials.entity));
        if (!valid) throw new Error(`Actor claim failed: ${result.error ?? result.message ?? 'invalid claim response'}`);
        // Reassert interest after claiming so the server can bind private social
        // visibility to this actor rather than the anonymous opening stream.
        active.send(JSON.stringify({ type: 'set-interest', enabled: true }));
        state = 'open';
        refilledAt = now();
        tokens = rate;
        pumpQueue();
      } catch (error) {
        state = 'failed';
        settlePending('link_closed', 'Actor link connection failed');
        flushQueue();
        try { active.close(1000, 'claim failed'); } catch { /* already closed */ }
        const message = error instanceof Error ? error.message : String(error);
        deliverClose(message);
        throw error;
      }
    },
    onEvent(listener: (event: ServerEvent) => void): () => void {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    onClose(listener: (reason: string) => void): () => void {
      closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    eventsSince(seq: number): readonly ServerEvent[] {
      return events.filter((event) => event.seq > seq);
    },
    async submit(intent: ActionIntent): Promise<ActionOutcome> {
      let outcome: ActionOutcome;
      if (deniedCommandTypes.has(intent.type)) {
        outcome = deniedOutcome(intent, lastTick, now);
      } else if (!commandTypes.has(intent.type) || adminCommandTypes.has(intent.type)) {
        outcome = invalidOutcome(intent, lastTick, now);
      } else {
        const { result, sentAt } = await queuedSend(intent.type, {
          ...intent.data,
          entity: credentials.entity
        });
        outcome = {
          intent,
          ok: result.ok,
          ...(result.error === undefined ? {} : { code: result.error }),
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.details === undefined ? {} : { details: result.details }),
          tick: result.tick,
          sentAt
        };
      }
      if (options.agentId !== undefined) {
        bus.emit('agent.action', { agentId: options.agentId, outcome });
      }
      return outcome;
    },
    async sendRaw(type: string, data: Readonly<Record<string, unknown>>): Promise<CommandResult> {
      return (await queuedSend(type, data)).result;
    },
    async get(path: string): Promise<JsonValue> {
      const response = await fetchImpl(`${credentials.httpUrl}${path}`);
      const text = await response.text();
      const body = jsonBody(text);
      if (!response.ok) throw new LinkHttpError(response.status, body);
      return body;
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        const active = socket;
        if (state === 'open' && active !== undefined && active.readyState === WebSocket.OPEN) {
          const id = `leave-${++sequence}`;
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              resolve();
            }, 300);
            pending.set(id, {
              timeout,
              resolve: () => resolve()
            });
            try {
              active.send(JSON.stringify({ type: 'leave', instance: credentials.instanceId, id, data: {} }));
            } catch {
              clearTimeout(timeout);
              pending.delete(id);
              resolve();
            }
          });
        }
        socket = undefined;
        if (state !== 'failed') state = 'closed';
        settlePending('link_closed', 'Actor link closed');
        flushQueue();
        try { deliverClose('Actor link closed'); } catch { /* listener failures must not block shutdown */ }
        if (active === undefined || active.readyState === WebSocket.CLOSED) return;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 500);
          try {
            active.addEventListener('close', () => {
              clearTimeout(timeout);
              resolve();
            }, { once: true });
            active.close(1000, 'harness finished');
          } catch {
            clearTimeout(timeout);
            resolve();
          }
        });
      })().catch(() => { /* close is best-effort and never rejects */ });
      return closePromise;
    }
  };
  return link;
}
