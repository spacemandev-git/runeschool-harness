/**
 * Control plane: a running harness exposes its {@link RuntimeView}, {@link RuntimeCommands}, and
 * {@link HarnessBus} over a per-run Unix socket so a cockpit can attach from another terminal (or
 * an SSH session) and detach again without stopping the run. Daemon mode is just a headless run
 * plus this server, started detached.
 *
 * Auth is the socket's file mode (0600, owner only). The descriptor JSON next to it lets
 * `harness ps` / `attach latest` discover live runs.
 */
import type { JsonValue } from '#protocol';
import type { HarnessBus, HarnessEvent } from './bus.ts';
import type { LiveRuntimeCommands, RuntimeCommands, RuntimeView } from './runtime.ts';
import type { RunId } from './types.ts';

/** `<logDir>/<runId>.control.json`, written when the server listens, removed on close. */
export interface ControlDescriptor {
  readonly runId: RunId;
  readonly pid: number;
  readonly socketPath: string;
  readonly startedAt: number;
  readonly mcpUrl: string;
  /** Daemon stdout/stderr log, when started with `--daemon`. */
  readonly logPath?: string;
  readonly instanceId?: string;
}

export const CONTROL_VIEW_METHODS = [
  'agents', 'teams', 'agentSnapshot', 'agentReflexes', 'agentTranscript',
  'directorTranscript', 'adminTranscript', 'coordinatorTranscript', 'usage', 'config'
] as const;
export type ControlViewMethod = (typeof CONTROL_VIEW_METHODS)[number];

export const CONTROL_COMMAND_METHODS = [
  'directorSay', 'adminSay', 'agentSay', 'coordinatorSay', 'setAgentGoal',
  'pauseAgent', 'resumeAgent', 'agentCommand', 'spawnAgent', 'removeAgent',
  'setModel', 'setAgentModel', 'createTeam', 'stop'
] as const;
export type ControlCommandMethod = (typeof CONTROL_COMMAND_METHODS)[number];

/** Everything the attached cockpit needs to render, fetched in one round trip. */
export interface ControlSnapshot {
  readonly runId: RunId;
  readonly startedAt: number;
  readonly instance?: RuntimeView['instance'];
  readonly agents: ReturnType<RuntimeView['agents']>;
  readonly teams: ReturnType<RuntimeView['teams']>;
  readonly usage: ReturnType<RuntimeView['usage']>;
  readonly config: JsonValue;
}

export type ControlClientMessage =
  | { readonly type: 'hello'; /** Replay bus history after this seq (0 = everything retained). */ readonly sinceSeq?: number }
  | { readonly type: 'snapshot'; readonly id: string }
  | { readonly type: 'view'; readonly id: string; readonly method: ControlViewMethod; readonly args: readonly JsonValue[] }
  | { readonly type: 'command'; readonly id: string; readonly method: ControlCommandMethod; readonly args: readonly JsonValue[] }
  | { readonly type: 'ping' };

export type ControlServerMessage =
  | { readonly type: 'welcome'; readonly descriptor: ControlDescriptor; readonly snapshot: ControlSnapshot }
  | { readonly type: 'event'; readonly event: HarnessEvent }
  | { readonly type: 'result'; readonly id: string; readonly ok: true; readonly value: JsonValue }
  | { readonly type: 'result'; readonly id: string; readonly ok: false; readonly error: string }
  | { readonly type: 'pong' }
  | { readonly type: 'closing'; readonly reason: string };

export interface ControlServerOptions {
  readonly runId: RunId;
  readonly logDir: string;
  readonly mcpUrl: string;
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  readonly bus: HarnessBus;
  readonly logPath?: string;
  /** Bus events replayed to a fresh client (default 1000, newest). */
  readonly replayLimit?: number;
}

export interface ControlServer {
  readonly socketPath: string;
  readonly descriptorPath: string;
  readonly descriptor: ControlDescriptor;
  /** Tell clients the run is going away (they detach), unlink socket + descriptor. Idempotent. */
  close(reason?: string): Promise<void>;
}

export interface ControlClientOptions {
  /** How often the cached view is refreshed while attached (default 500 ms). */
  readonly pollMs?: number;
}

/**
 * A remote runtime that satisfies the cockpit's contract: `view` methods are synchronous reads of a
 * cache refreshed by polling and by incoming bus events; `commands` round-trip to the run; `bus`
 * is a local bus fed by the event stream (history seeded from the server's replay).
 */
export interface ControlClient {
  readonly descriptor: ControlDescriptor;
  readonly view: RuntimeView;
  readonly commands: LiveRuntimeCommands;
  readonly bus: HarnessBus;
  /** Resolves when the server closes (run finished/stopped) or after `close()`; the reason is the server's. */
  readonly closed: Promise<string>;
  /** Detach; the run keeps going. Idempotent. */
  close(): Promise<void>;
}

export type ControlServerFactory = (options: ControlServerOptions) => Promise<ControlServer>;
export type ControlClientFactory = (descriptorOrSocketPath: ControlDescriptor | string, options?: ControlClientOptions) => Promise<ControlClient>;
