import type {
  CommandResult,
  EntityId,
  EntityKind,
  ServerEvent,
  TileCoord
} from '../shared/index.ts';
import type { WaitForOptions } from './types.ts';
import type { ClaimResult, ConnectOptions } from './types.ts';

declare module './types.ts' {
  interface ConnectOptions {
    /** Number of recent stream events retained in memory. Defaults to 2048. */
    readonly retainEvents?: number;
  }
}

interface IteratorState {
  /** Absolute index of the next retained event to read. */
  cursor: number;
  done: boolean;
  readonly pending: Array<{
    resolve(result: IteratorResult<ServerEvent>): void;
  }>;
}

interface PendingCommand {
  resolve(result: CommandResult): void;
  reject(error: Error): void;
}

interface EventWaiter {
  seen: number;
  readonly predicate: (event: ServerEvent) => unknown;
  readonly resolve: (value: never) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class CommandRejected extends Error {
  override readonly name = 'CommandRejected';

  constructor(
    readonly code: string,
    readonly id: string,
    readonly tick: number
  ) {
    super(`Command ${id} was rejected: ${code}`);
  }
}

export class WaitForTimeout extends Error {
  override readonly name = 'WaitForTimeout';

  constructor(
    readonly timeoutMs: number,
    readonly eventsSeen: number
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for an event (${eventsSeen} events seen)`);
  }
}

/**
 * A live instance event stream.
 *
 * The stream retains only the latest `retainEvents` events (2048 by default). Existing `waitFor`
 * calls are also dispatched directly, so they continue to observe matching events after older
 * retained entries have been overwritten.
 */
export class InstanceStream implements AsyncIterable<ServerEvent> {
  private readonly events: ServerEvent[] = [];
  private eventOffset = 0;
  private eventCount = 0;
  private readonly iterators = new Set<IteratorState>();
  private readonly commands = new Map<string, PendingCommand>();
  private readonly waiters = new Set<EventWaiter>();
  private nextCommandId = 1;
  private ended = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly instanceId: string,
    private readonly retainEvents = 2048
  ) {
    if (!Number.isSafeInteger(retainEvents) || retainEvents <= 0) {
      throw new RangeError('retainEvents must be a positive safe integer');
    }
    socket.addEventListener('message', (event) => this.receive(event));
    socket.addEventListener('close', () => this.finish(new Error('Instance stream closed')));
    socket.addEventListener('error', () => this.finish(new Error('Instance stream failed')));
  }

  static connect(
    url: string,
    instanceId: string,
    opts: ConnectOptions = {}
  ): Promise<InstanceStream> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const stream = new InstanceStream(socket, instanceId, opts.retainEvents);
      const opened = () => {
        cleanup();
        if (opts.token === undefined) {
          resolve(stream);
          return;
        }
        void stream.claim(opts.token).then(
          () => resolve(stream),
          (error: unknown) => {
            stream.close();
            reject(error);
          }
        );
      };
      const failed = () => {
        cleanup();
        reject(new Error(`Failed to connect instance stream: ${url}`));
      };
      const cleanup = () => {
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
      };
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<ServerEvent> {
    const state: IteratorState = { cursor: this.eventOffset, done: false, pending: [] };
    this.iterators.add(state);
    return {
      next: () => this.iteratorNext(state),
      return: () => {
        this.endIterator(state);
        return Promise.resolve({ done: true, value: undefined });
      }
    };
  }

  send(type: string, data: unknown): Promise<CommandResult> {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Instance stream is not open'));
    }
    const id = `sdk-${this.nextCommandId++}`;
    return new Promise((resolve, reject) => {
      this.commands.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ type, instance: this.instanceId, id, data }));
      } catch (error) {
        this.commands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  claim(token: string): Promise<ClaimResult> {
    return this.send('claim', { token }) as Promise<ClaimResult>;
  }

  setInterest(opts: {
    readonly enabled?: boolean;
    readonly radius?: number;
    readonly center?: { readonly x: number; readonly z: number };
  }): void {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'set-interest',
      enabled: opts.enabled ?? true,
      ...(opts.radius === undefined ? {} : { radius: opts.radius }),
      ...(opts.center === undefined ? {} : { center: opts.center })
    }));
  }

  walk(entity: EntityId, dest: TileCoord): Promise<CommandResult> {
    return this.send('walk', { entity, dest });
  }

  run(entity: EntityId, dest: TileCoord): Promise<CommandResult> {
    return this.send('run', { entity, dest });
  }

  move(entity: EntityId, at: TileCoord): Promise<CommandResult> {
    return this.send('move', { entity, at });
  }

  spawn(kind: EntityKind, at: TileCoord): Promise<CommandResult> {
    return this.send('spawn', { kind, at });
  }

  stepCmd(ticks: number): Promise<CommandResult> {
    return this.send('step', { ticks });
  }

  end(reason = 'finished'): Promise<CommandResult> {
    return this.send('end', { reason });
  }

  waitFor<T>(
    predicate: (event: ServerEvent) => T | undefined,
    opts: WaitForOptions = {}
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    return new Promise<T>((resolve, reject) => {
      let seen = 0;
      try {
        for (let index = this.eventOffset; index < this.eventCount; index++) {
          const event = this.retainedEvent(index);
          if (event === undefined) continue;
          seen++;
          const value = predicate(event);
          if (value) {
            resolve(value);
            return;
          }
        }
      } catch (error) {
        reject(error);
        return;
      }

      if (this.ended) {
        reject(new Error(`Instance stream closed after ${seen} events`));
        return;
      }

      const waiter: EventWaiter = {
        seen,
        predicate,
        resolve: resolve as (value: never) => void,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new WaitForTimeout(timeoutMs, waiter.seen));
        }, timeoutMs)
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.ended) return;
    this.finish(new Error('Instance stream closed by client'));
    this.socket.close(1000, 'client closed');
  }

  private receive(message: MessageEvent): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(message.data)) as unknown;
    } catch {
      this.finish(new Error('Instance stream received invalid JSON'));
      this.socket.close(1002, 'invalid JSON');
      return;
    }

    if (this.isCommandResult(frame)) {
      const pending = this.commands.get(frame.id);
      if (pending === undefined) return;
      this.commands.delete(frame.id);
      if (frame.ok) pending.resolve(frame);
      else pending.reject(new CommandRejected(frame.error ?? 'unknown_error', frame.id, frame.tick));
      return;
    }

    if (this.isEventBatch(frame)) {
      for (const event of frame.events) this.receiveEvent(event);
      return;
    }
    if (this.isServerEvent(frame)) this.receiveEvent(frame);
  }

  private receiveEvent(event: ServerEvent): void {
    this.retain(event);
    this.dispatchIterators();
    this.dispatchWaiters(event);
  }

  private isCommandResult(value: unknown): value is CommandResult {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as Partial<CommandResult>;
    return typeof frame.id === 'string' && typeof frame.ok === 'boolean'
      && typeof frame.tick === 'number';
  }

  private isServerEvent(value: unknown): value is ServerEvent {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as Partial<ServerEvent>;
    return typeof frame.type === 'string' && typeof frame.instance === 'string'
      && typeof frame.tick === 'number' && typeof frame.seq === 'number' && 'data' in frame;
  }

  private isEventBatch(value: unknown): value is { readonly type: 'event-batch'; readonly events: ServerEvent[] } {
    if (typeof value !== 'object' || value === null) return false;
    const frame = value as { readonly type?: unknown; readonly events?: unknown };
    return frame.type === 'event-batch' && Array.isArray(frame.events)
      && frame.events.every((event) => this.isServerEvent(event));
  }

  private iteratorNext(state: IteratorState): Promise<IteratorResult<ServerEvent>> {
    if (state.done) return Promise.resolve({ done: true, value: undefined });
    if (state.cursor < this.eventOffset) state.cursor = this.eventOffset;
    const event = this.retainedEvent(state.cursor);
    if (event !== undefined) {
      state.cursor++;
      return Promise.resolve({ done: false, value: event });
    }
    if (this.ended) {
      this.endIterator(state);
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => state.pending.push({ resolve }));
  }

  private dispatchIterators(): void {
    for (const state of this.iterators) {
      if (state.cursor < this.eventOffset) state.cursor = this.eventOffset;
      while (!state.done && state.pending.length > 0) {
        const event = this.retainedEvent(state.cursor);
        if (event === undefined) break;
        state.cursor++;
        state.pending.shift()!.resolve({ done: false, value: event });
      }
    }
  }

  private retain(event: ServerEvent): void {
    const slot = this.eventCount % this.retainEvents;
    if (this.events.length < this.retainEvents) this.events.push(event);
    else this.events[slot] = event;
    this.eventCount++;
    this.eventOffset = Math.max(0, this.eventCount - this.retainEvents);
  }

  private retainedEvent(index: number): ServerEvent | undefined {
    if (index < this.eventOffset || index >= this.eventCount) return undefined;
    return this.events[index % this.retainEvents];
  }

  private dispatchWaiters(event: ServerEvent): void {
    for (const waiter of [...this.waiters]) {
      waiter.seen++;
      try {
        const value = waiter.predicate(event);
        if (!value) continue;
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve(value as never);
      } catch (error) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private endIterator(state: IteratorState): void {
    if (state.done) return;
    state.done = true;
    this.iterators.delete(state);
    for (const pending of state.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  private finish(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.commands.values()) pending.reject(error);
    this.commands.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
    for (const state of [...this.iterators]) this.endIterator(state);
  }
}
