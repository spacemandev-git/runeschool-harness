/** In-memory implementation of the core HarnessBus contract. Shared by every module and test. */
import type { HarnessBus, HarnessEvent, HarnessEventMap, HarnessEventType, HarnessListener } from '../core/bus.ts';

export function createBus(options: { readonly historyLimit?: number } = {}): HarnessBus {
  const historyLimit = options.historyLimit ?? 5_000;
  const listeners = new Map<HarnessEventType, Set<(event: HarnessEvent) => void>>();
  const anyListeners = new Set<(event: HarnessEvent) => void>();
  const history: HarnessEvent[] = [];
  let seq = 0;
  return {
    emit<T extends HarnessEventType>(type: T, data: HarnessEventMap[T]): void {
      const event = { type, at: Date.now(), seq: ++seq, data } as HarnessEvent;
      history.push(event);
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
      for (const listener of listeners.get(type) ?? []) listener(event);
      for (const listener of anyListeners) listener(event);
    },
    on<T extends HarnessEventType>(type: T, listener: HarnessListener<T>): () => void {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      const wrapped = listener as unknown as (event: HarnessEvent) => void;
      set.add(wrapped);
      return () => { set.delete(wrapped); };
    },
    onAny(listener): () => void {
      anyListeners.add(listener);
      return () => { anyListeners.delete(listener); };
    },
    history(opts = {}): readonly HarnessEvent[] {
      const filtered = opts.prefix === undefined ? history : history.filter((event) => event.type.startsWith(opts.prefix!));
      return opts.limit === undefined ? filtered.slice() : filtered.slice(-opts.limit);
    }
  };
}
