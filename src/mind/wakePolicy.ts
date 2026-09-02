import type { WakePolicyConfig } from '../core/agent.ts';
import type { HarnessBus } from '../core/bus.ts';
import type { WakeReason } from '../core/types.ts';

export interface WakePolicyDeps {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly run: (reasons: readonly WakeReason[], note?: string) => Promise<void>;
  readonly bus?: HarnessBus;
  readonly agentId?: string;
}

export interface WakePolicy {
  request(reason: WakeReason, note?: string): Promise<void>;
  setActive(active: boolean): void;
  dispose(): void;
  readonly turns: number;
  readonly busy: boolean;
}

interface Deferred {
  resolve(): void;
}

interface PendingWake {
  reasons: WakeReason[];
  notes: string[];
  waiters: Deferred[];
}

export function createWakePolicy(config: WakePolicyConfig, deps: WakePolicyDeps): WakePolicy {
  let active = false;
  let disposed = false;
  let running = false;
  let turnCount = 0;
  let lastStartedAt: number | undefined;
  let launchTimer: unknown;
  let heartbeatTimer: unknown;
  let warnedMax = false;
  let pending: PendingWake | undefined;

  function clearLaunch(): void {
    if (launchTimer !== undefined) deps.clearTimeout(launchTimer);
    launchTimer = undefined;
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) deps.clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function warnMax(): void {
    if (warnedMax) return;
    warnedMax = true;
    deps.bus?.emit('log', {
      level: 'warn',
      scope: deps.agentId === undefined ? 'mind.wake' : `mind.${deps.agentId}.wake`,
      message: `Maximum mind turns reached (${config.maxTurns}); further wakes are ignored.`
    });
  }

  function atLimit(): boolean {
    return config.maxTurns > 0 && turnCount >= config.maxTurns;
  }

  function resolvePending(): void {
    const dropped = pending;
    pending = undefined;
    for (const waiter of dropped?.waiters ?? []) waiter.resolve();
  }

  function armHeartbeat(): void {
    clearHeartbeat();
    if (!active || disposed || running || pending !== undefined || atLimit()) return;
    heartbeatTimer = deps.setTimeout(() => {
      heartbeatTimer = undefined;
      void request('heartbeat');
    }, Math.max(0, config.heartbeatMs));
  }

  function schedule(): void {
    if (disposed || running || pending === undefined || launchTimer !== undefined) return;
    if (atLimit()) {
      warnMax();
      resolvePending();
      return;
    }
    const earliest = lastStartedAt === undefined ? deps.now() : lastStartedAt + Math.max(0, config.minIntervalMs);
    const delay = Math.max(0, earliest - deps.now());
    if (delay === 0) {
      void start();
      return;
    }
    launchTimer = deps.setTimeout(() => {
      launchTimer = undefined;
      void start();
    }, delay);
  }

  async function start(): Promise<void> {
    if (disposed || running || pending === undefined) return;
    if (atLimit()) {
      warnMax();
      resolvePending();
      return;
    }
    clearLaunch();
    clearHeartbeat();
    const batch = pending;
    pending = undefined;
    running = true;
    lastStartedAt = deps.now();
    turnCount++;
    try {
      const note = batch.notes.length === 0 ? undefined : batch.notes.join('; ');
      await deps.run(batch.reasons, note);
    } catch (error) {
      deps.bus?.emit('log', {
        level: 'error',
        scope: deps.agentId === undefined ? 'mind.wake' : `mind.${deps.agentId}.wake`,
        message: `Wake runner failed: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      running = false;
      for (const waiter of batch.waiters) waiter.resolve();
      if (disposed) {
        resolvePending();
      } else if (atLimit()) {
        warnMax();
        resolvePending();
      } else if (pending !== undefined) {
        schedule();
      } else {
        armHeartbeat();
      }
    }
  }

  function request(reason: WakeReason, note?: string): Promise<void> {
    if (disposed || atLimit()) {
      if (atLimit()) warnMax();
      return Promise.resolve();
    }
    clearHeartbeat();
    return new Promise<void>((resolve) => {
      if (pending === undefined) pending = { reasons: [], notes: [], waiters: [] };
      if (!pending.reasons.includes(reason)) pending.reasons.push(reason);
      if (note !== undefined && note.trim().length > 0) pending.notes.push(note.trim());
      pending.waiters.push({ resolve });
      schedule();
    });
  }

  return {
    request,
    setActive(value): void {
      active = value;
      if (active) armHeartbeat();
      else clearHeartbeat();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      clearLaunch();
      clearHeartbeat();
      resolvePending();
    },
    get turns(): number { return turnCount; },
    get busy(): boolean { return running; }
  };
}
