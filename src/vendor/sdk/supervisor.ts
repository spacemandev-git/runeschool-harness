import type {
  CommandResult,
  EntityId,
  EntityKind,
  ServerEvent,
  TileCoord
} from '../shared/index.ts';
import type { InstanceHandle } from './instanceHandle.ts';
import { CommandRejected, WaitForTimeout, type InstanceStream } from './stream.ts';
import type { ClaimResult, ConnectOptions, WaitForOptions } from './types.ts';

export class StreamReconnected extends Error {
  override readonly name = 'StreamReconnected';

  constructor(readonly since: number) {
    super(`Instance stream reconnected from sequence ${since}`);
  }
}

export interface SupervisedConnectOptions {
  readonly token?: string;
  readonly since?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  readonly onReconnect?: (info: { readonly attempt: number; readonly since: number }) => void;
}

interface IteratorState {
  cursor: number;
  done: boolean;
  readonly pending: Array<{ resolve(result: IteratorResult<ServerEvent>): void }>;
}

interface Waiter {
  seen: number;
  readonly predicate: (event: ServerEvent) => unknown;
  readonly resolve: (value: never) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PendingSend {
  reject(error: Error): void;
}

const defaultBackoff = (attempt: number): number =>
  Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** An InstanceStream-compatible facade whose iterators survive socket replacement. */
export class ReconnectingStream implements AsyncIterable<ServerEvent> {
  private readonly events: ServerEvent[] = [];
  private eventOffset = 0;
  private eventCount = 0;
  private readonly retainEvents = 2048;
  private readonly iterators = new Set<IteratorState>();
  private readonly waiters = new Set<Waiter>();
  private readonly pendingSends = new Set<PendingSend>();
  private current?: InstanceStream;
  private generation = 0;
  private reconnecting?: Promise<void>;
  private stopped = false;
  private token?: string;
  private interest?: Parameters<InstanceStream['setInterest']>[0];
  private _lastSeq: number;
  private _attempts = 0;

  private constructor(
    private readonly handle: InstanceHandle,
    initial: InstanceStream,
    private readonly options: SupervisedConnectOptions
  ) {
    this.current = initial;
    this.token = options.token;
    this._lastSeq = options.since ?? 0;
    this.pump(initial, this.generation);
  }

  static async connect(
    handle: InstanceHandle,
    options: SupervisedConnectOptions = {}
  ): Promise<ReconnectingStream> {
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (!(maxAttempts === Number.POSITIVE_INFINITY
      || (Number.isSafeInteger(maxAttempts) && maxAttempts >= 0))) {
      throw new RangeError('maxAttempts must be a non-negative safe integer or Infinity');
    }
    const initial = await handle.connect(options.since, { token: options.token });
    return new ReconnectingStream(handle, initial, options);
  }

  get lastSeq(): number { return this._lastSeq; }
  get attempts(): number { return this._attempts; }

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
    const stream = this.current;
    if (this.stopped || stream === undefined || this.reconnecting !== undefined) {
      return Promise.reject(new StreamReconnected(this._lastSeq));
    }
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const pending: PendingSend = { reject };
      this.pendingSends.add(pending);
      void stream.send(type, data).then(
        (result) => {
          if (!this.pendingSends.delete(pending)) return;
          resolve(result);
        },
        (error: unknown) => {
          if (!this.pendingSends.delete(pending)) return;
          if (error instanceof CommandRejected || this.stopped) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          reject(new StreamReconnected(this._lastSeq));
          this.disconnected(stream, generation);
        }
      );
    });
  }

  async claim(token: string): Promise<ClaimResult> {
    const result = await this.send('claim', { token }) as ClaimResult;
    this.token = token;
    return result;
  }

  setInterest(opts: Parameters<InstanceStream['setInterest']>[0]): void {
    this.interest = opts;
    this.current?.setInterest(opts);
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
      if (this.stopped) {
        reject(new Error(`Instance stream closed after ${seen} events`));
        return;
      }
      const waiter: Waiter = {
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

  close(): void { this.stop(); }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    const stream = this.current;
    this.current = undefined;
    stream?.close();
    const error = new Error('Instance stream closed by client');
    this.rejectPending(error);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
    for (const state of [...this.iterators]) this.endIterator(state);
  }

  private pump(stream: InstanceStream, generation: number): void {
    void (async () => {
      try {
        for await (const event of stream) {
          if (this.stopped || generation !== this.generation) return;
          this.receive(event);
        }
      } finally {
        this.disconnected(stream, generation);
      }
    })();
  }

  private disconnected(stream: InstanceStream, generation: number): void {
    if (this.stopped || generation !== this.generation || this.current !== stream) return;
    this.generation++;
    this.current = undefined;
    this.rejectPending(new StreamReconnected(this._lastSeq));
    this.reconnecting ??= this.reconnect().finally(() => { this.reconnecting = undefined; });
  }

  private async reconnect(): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? Number.POSITIVE_INFINITY;
    const backoff = this.options.backoffMs ?? defaultBackoff;
    let lastError: Error = new Error('Instance stream reconnect attempts exhausted');
    while (!this.stopped && this._attempts < maxAttempts) {
      const attempt = ++this._attempts;
      await delay(backoff(attempt));
      if (this.stopped) return;
      try {
        const stream = await this.handle.connect(this._lastSeq, { token: this.token } satisfies ConnectOptions);
        if (this.stopped) {
          stream.close();
          return;
        }
        this.current = stream;
        const generation = this.generation;
        if (this.interest !== undefined) stream.setInterest(this.interest);
        this.options.onReconnect?.({ attempt, since: this._lastSeq });
        this.pump(stream, generation);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!this.stopped) this.finish(lastError);
  }

  private receive(event: ServerEvent): void {
    if (event.seq <= this._lastSeq) return;
    this._lastSeq = event.seq;
    const slot = this.eventCount % this.retainEvents;
    if (this.events.length < this.retainEvents) this.events.push(event);
    else this.events[slot] = event;
    this.eventCount++;
    this.eventOffset = Math.max(0, this.eventCount - this.retainEvents);
    this.dispatchIterators();
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

  private iteratorNext(state: IteratorState): Promise<IteratorResult<ServerEvent>> {
    if (state.done) return Promise.resolve({ done: true, value: undefined });
    if (state.cursor < this.eventOffset) state.cursor = this.eventOffset;
    const event = this.retainedEvent(state.cursor);
    if (event !== undefined) {
      state.cursor++;
      return Promise.resolve({ done: false, value: event });
    }
    if (this.stopped) {
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

  private retainedEvent(index: number): ServerEvent | undefined {
    if (index < this.eventOffset || index >= this.eventCount) return undefined;
    return this.events[index % this.retainEvents];
  }

  private endIterator(state: IteratorState): void {
    if (state.done) return;
    state.done = true;
    this.iterators.delete(state);
    for (const pending of state.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingSends) pending.reject(error);
    this.pendingSends.clear();
  }

  private finish(error: Error): void {
    this.stopped = true;
    this.rejectPending(error);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
    for (const state of [...this.iterators]) this.endIterator(state);
  }
}

export function connectSupervised(
  handle: InstanceHandle,
  opts: SupervisedConnectOptions = {}
): Promise<ReconnectingStream> {
  return ReconnectingStream.connect(handle, opts);
}
