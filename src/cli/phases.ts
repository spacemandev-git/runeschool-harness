import { TICK_MILLIS } from '#protocol';
import type { HarnessBus } from '../core/bus.ts';
import type { ControlDescriptor } from '../core/control.ts';
import type { AgentSummary, LiveRuntimeCommands, TeamSummary } from '../core/runtime.ts';
import { serverBaseUrlOf } from '../transport/index.ts';

export interface PhaseScript {
  readonly version: 1;
  readonly loop?: boolean;
  readonly maxCycles?: number;
  readonly phases: readonly Phase[];
}

export interface Phase {
  readonly name: string;
  readonly durationTicks?: number;
  readonly durationMs?: number;
  readonly onEnter?: readonly PhaseAction[];
  readonly onExit?: readonly PhaseAction[];
}

export type Selector =
  | { readonly agents: readonly string[] }
  | { readonly team: string }
  | { readonly all: true }
  | { readonly pollWinner: string };

export type PhaseAction =
  | { readonly kind: 'pause'; readonly select: Selector; readonly blind?: boolean; readonly reason?: string }
  | { readonly kind: 'resume'; readonly select: Selector }
  | { readonly kind: 'message'; readonly select: Selector; readonly text: string }
  | { readonly kind: 'director'; readonly text: string }
  | { readonly kind: 'command'; readonly select: Selector; readonly command: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: 'remove'; readonly select: Selector; readonly reason?: string }
  | { readonly kind: 'stop' };

export type PollWinners = ReadonlyMap<string, number | null>;

export interface PhaseControlClient {
  readonly descriptor: ControlDescriptor;
  readonly view: {
    agents(): readonly AgentSummary[];
    teams(): readonly TeamSummary[];
  };
  readonly commands: Pick<LiveRuntimeCommands,
    'pauseAgent' | 'resumeAgent' | 'agentSay' | 'directorSay' | 'agentCommand' | 'removeAgent' | 'stop'>;
  readonly bus: Pick<HarnessBus, 'on' | 'history'>;
  readonly closed: Promise<string>;
}

export interface PhaseRunnerOptions {
  readonly readTick?: () => Promise<number | undefined>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly tickPollMs?: number;
}

export type PhaseRunResult = 'script-ended' | 'stop-action' | 'run-stopped';

export class ControlSocketLossError extends Error {
  constructor() { super('control socket connection lost'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function keys(raw: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${path}.${extra} is not allowed`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive safe integer`);
  return value as number;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function validateSelector(value: unknown, path: string): Selector {
  const raw = object(value, path);
  keys(raw, ['agents', 'team', 'all', 'pollWinner'], path);
  const present = ['agents', 'team', 'all', 'pollWinner'].filter((key) => raw[key] !== undefined);
  if (present.length !== 1) throw new Error(`${path} must contain exactly one selector`);
  if (raw.agents !== undefined) {
    if (!Array.isArray(raw.agents) || !raw.agents.every((agent) => typeof agent === 'string')) {
      throw new Error(`${path}.agents must be an array of strings`);
    }
    return { agents: raw.agents };
  }
  if (raw.team !== undefined) return { team: string(raw.team, `${path}.team`) };
  if (raw.pollWinner !== undefined) return { pollWinner: string(raw.pollWinner, `${path}.pollWinner`) };
  if (raw.all !== true) throw new Error(`${path}.all must be true`);
  return { all: true };
}

function validateAction(value: unknown, path: string): PhaseAction {
  const raw = object(value, path);
  const kind = string(raw.kind, `${path}.kind`);
  if (kind === 'stop') {
    keys(raw, ['kind'], path);
    return { kind };
  }
  if (kind === 'director') {
    keys(raw, ['kind', 'text'], path);
    return { kind, text: string(raw.text, `${path}.text`) };
  }
  if (!['pause', 'resume', 'message', 'command', 'remove'].includes(kind)) {
    throw new Error(`${path}.kind '${kind}' is not supported`);
  }
  const select = validateSelector(raw.select, `${path}.select`);
  if (kind === 'pause') {
    keys(raw, ['kind', 'select', 'blind', 'reason'], path);
    const blind = optionalBoolean(raw.blind, `${path}.blind`);
    const reason = raw.reason === undefined ? undefined : string(raw.reason, `${path}.reason`);
    return { kind, select, ...(blind === undefined ? {} : { blind }), ...(reason === undefined ? {} : { reason }) };
  }
  if (kind === 'resume') {
    keys(raw, ['kind', 'select'], path);
    return { kind, select };
  }
  if (kind === 'message') {
    keys(raw, ['kind', 'select', 'text'], path);
    return { kind, select, text: string(raw.text, `${path}.text`) };
  }
  if (kind === 'command') {
    keys(raw, ['kind', 'select', 'command', 'data'], path);
    return {
      kind, select, command: string(raw.command, `${path}.command`),
      data: object(raw.data, `${path}.data`),
    };
  }
  if (kind === 'remove') {
    keys(raw, ['kind', 'select', 'reason'], path);
    const reason = raw.reason === undefined ? undefined : string(raw.reason, `${path}.reason`);
    return { kind, select, ...(reason === undefined ? {} : { reason }) };
  }
  throw new Error(`${path}.kind '${kind}' is not supported`);
}

function validateActions(value: unknown, path: string): readonly PhaseAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((action, index) => validateAction(action, `${path}[${index}]`));
}

function validatePhase(value: unknown, path: string): Phase {
  const raw = object(value, path);
  keys(raw, ['name', 'durationTicks', 'durationMs', 'onEnter', 'onExit'], path);
  const name = string(raw.name, `${path}.name`);
  const hasTicks = raw.durationTicks !== undefined;
  const hasMs = raw.durationMs !== undefined;
  if (hasTicks === hasMs) throw new Error(`${path} must contain exactly one of durationTicks or durationMs`);
  const duration = hasTicks
    ? { durationTicks: positiveInteger(raw.durationTicks, `${path}.durationTicks`) }
    : { durationMs: positiveInteger(raw.durationMs, `${path}.durationMs`) };
  const onEnter = validateActions(raw.onEnter, `${path}.onEnter`);
  const onExit = validateActions(raw.onExit, `${path}.onExit`);
  return {
    name, ...duration,
    ...(onEnter === undefined ? {} : { onEnter }),
    ...(onExit === undefined ? {} : { onExit }),
  };
}

/** Validate and normalize a JSON phase script without adding a schema dependency. */
export function validatePhaseScript(value: unknown): PhaseScript {
  const raw = object(value, 'script');
  keys(raw, ['version', 'loop', 'maxCycles', 'phases'], 'script');
  if (raw.version !== 1) throw new Error('script.version must be 1');
  const loop = optionalBoolean(raw.loop, 'script.loop');
  const maxCycles = raw.maxCycles === undefined ? undefined : positiveInteger(raw.maxCycles, 'script.maxCycles');
  if (!Array.isArray(raw.phases) || raw.phases.length === 0) throw new Error('script.phases must be a non-empty array');
  return {
    version: 1,
    ...(loop === undefined ? {} : { loop }),
    ...(maxCycles === undefined ? {} : { maxCycles }),
    phases: raw.phases.map((phase, index) => validatePhase(phase, `script.phases[${index}]`)),
  };
}

export function resolveSelector(
  selector: Selector,
  snapshot: { readonly agents: readonly AgentSummary[]; readonly teams: readonly TeamSummary[] },
  pollWinners: PollWinners,
): readonly string[] {
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  if ('all' in selector) return snapshot.agents.map((agent) => agent.id);
  if ('agents' in selector) {
    const missing = selector.agents.find((agent) => !agentsById.has(agent));
    if (missing !== undefined) throw new Error(`selector references unknown agent '${missing}'`);
    return [...new Set(selector.agents)];
  }
  if ('team' in selector) {
    const team = snapshot.teams.find((entry) => entry.id === selector.team);
    if (team === undefined) throw new Error(`selector references unknown team '${selector.team}'`);
    return team.agents.filter((agent) => agentsById.has(agent));
  }
  if (!pollWinners.has(selector.pollWinner)) {
    throw new Error(`no poll-closed event has been seen for poll '${selector.pollWinner}'`);
  }
  const winner = pollWinners.get(selector.pollWinner);
  if (winner === null) return [];
  const agent = snapshot.agents.find((entry) => entry.entity === winner);
  if (agent === undefined) throw new Error(`poll '${selector.pollWinner}' winner entity ${String(winner)} is not a harness agent`);
  return [agent.id];
}

function snapshot(client: PhaseControlClient): { readonly agents: readonly AgentSummary[]; readonly teams: readonly TeamSummary[] } {
  return { agents: client.view.agents(), teams: client.view.teams() };
}

async function applyActions(
  actions: readonly PhaseAction[],
  client: PhaseControlClient,
  pollWinners: PollWinners,
  close: CloseState,
): Promise<'continue' | 'stop' | 'closed'> {
  const invoke = async (command: () => unknown): Promise<boolean> => {
    const result = await orClosed(Promise.resolve().then(command), close);
    return result.kind === 'closed';
  };
  for (const action of actions) {
    if (action.kind === 'director') {
      if (await invoke(() => client.commands.directorSay(action.text))) return 'closed';
      continue;
    }
    if (action.kind === 'stop') {
      const closed = await invoke(() => client.commands.stop('phase script stop'));
      return closed && close.reason() === 'connection lost' ? 'closed' : 'stop';
    }
    const agents = resolveSelector(action.select, snapshot(client), pollWinners);
    for (const agent of agents) {
      if (action.kind === 'pause') {
        if (await invoke(() => client.commands.pauseAgent(
          agent, action.reason ?? 'phase controller',
          action.blind === undefined ? undefined : { blind: action.blind },
        ))) return 'closed';
      } else if (action.kind === 'resume') {
        if (await invoke(() => client.commands.resumeAgent(agent))) return 'closed';
      } else if (action.kind === 'message') {
        if (await invoke(() => client.commands.agentSay(agent, action.text))) return 'closed';
      } else if (action.kind === 'command') {
        if (await invoke(() => client.commands.agentCommand(agent, action.command, action.data))) return 'closed';
      } else {
        if (await invoke(() => client.commands.removeAgent(agent, action.reason))) return 'closed';
      }
    }
  }
  return 'continue';
}

type WaitResult<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'closed'; readonly reason: string };
interface CloseState { readonly signal: AbortSignal; readonly reason: () => string }

async function orClosed<T>(pending: Promise<T>, close: CloseState): Promise<WaitResult<T>> {
  if (close.signal.aborted) return { kind: 'closed', reason: close.reason() };
  return await new Promise<WaitResult<T>>((resolve, reject) => {
    const onClose = (): void => {
      close.signal.removeEventListener('abort', onClose);
      resolve({ kind: 'closed', reason: close.reason() });
    };
    close.signal.addEventListener('abort', onClose, { once: true });
    void pending.then(
      (value) => {
        close.signal.removeEventListener('abort', onClose);
        resolve({ kind: 'value', value });
      },
      (error: unknown) => {
        close.signal.removeEventListener('abort', onClose);
        reject(error);
      },
    );
  });
}

function stopped(reason: string): PhaseRunResult {
  if (reason === 'connection lost') throw new ControlSocketLossError();
  return 'run-stopped';
}

function waitWithTimer(milliseconds: number, close: CloseState): Promise<WaitResult<void>> {
  if (close.signal.aborted) return Promise.resolve({ kind: 'closed', reason: close.reason() });
  return new Promise((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      close.signal.removeEventListener('abort', onClose);
      resolve({ kind: 'closed', reason: close.reason() });
    };
    const timer = setTimeout(() => {
      close.signal.removeEventListener('abort', onClose);
      resolve({ kind: 'value', value: undefined });
    }, milliseconds);
    close.signal.addEventListener('abort', onClose, { once: true });
  });
}

/** Derive the simulation HTTP origin/path prefix from the configured MCP endpoint. */
export function httpBaseUrlOf(mcpUrl: string): string {
  const url = new URL(serverBaseUrlOf(mcpUrl));
  url.pathname = url.pathname.replace(/\/mcp\/?$/, '');
  return serverBaseUrlOf(url.toString());
}

export function createTickReader(
  descriptor: Pick<ControlDescriptor, 'mcpUrl' | 'instanceId'>,
  fetcher: typeof fetch = fetch,
): () => Promise<number | undefined> {
  if (descriptor.instanceId === undefined) return async () => undefined;
  const url = `${httpBaseUrlOf(descriptor.mcpUrl)}/instances/${encodeURIComponent(descriptor.instanceId)}`;
  return async () => {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return undefined;
      const value = await response.json() as unknown;
      return isRecord(value) && Number.isSafeInteger(value.tick) && (value.tick as number) >= 0
        ? value.tick as number : undefined;
    } catch {
      return undefined;
    }
  };
}

async function waitForPhase(
  phase: Phase,
  options: {
    readonly readTick: () => Promise<number | undefined>;
    readonly wait: (milliseconds: number) => Promise<WaitResult<void>>;
    readonly tickPollMs: number;
    readonly close: CloseState;
  },
  initialTick?: number,
): Promise<{ readonly closed?: string; readonly tickRange?: readonly [number, number] }> {
  if (phase.durationMs !== undefined) {
    const result = await options.wait(phase.durationMs);
    return result.kind === 'closed' ? { closed: result.reason } : {};
  }

  const ticks = phase.durationTicks!;
  if (initialTick === undefined) {
    const fallback = await options.wait(ticks * TICK_MILLIS);
    return fallback.kind === 'closed' ? { closed: fallback.reason } : {};
  }

  const target = initialTick + ticks;
  let lastTick = initialTick;
  while (lastTick < target) {
    const delay = await options.wait(options.tickPollMs);
    if (delay.kind === 'closed') return { closed: delay.reason, tickRange: [initialTick, target] };
    const next = await orClosed(options.readTick(), options.close);
    if (next.kind === 'closed') return { closed: next.reason, tickRange: [initialTick, target] };
    if (next.value === undefined) {
      const fallback = await options.wait(Math.max(0, target - lastTick) * TICK_MILLIS);
      return fallback.kind === 'closed'
        ? { closed: fallback.reason, tickRange: [initialTick, target] }
        : { tickRange: [initialTick, target] };
    }
    lastTick = next.value;
  }
  return { tickRange: [initialTick, target] };
}

/** Run a validated phase script against an attached control client. */
export async function runPhaseScript(
  script: PhaseScript,
  client: PhaseControlClient,
  options: PhaseRunnerOptions = {},
): Promise<PhaseRunResult> {
  const pollWinners = new Map<string, number | null>();
  const observePolls = (event: ReturnType<HarnessBus['history']>[number]): void => {
    if (event.type !== 'agent.events') return;
    for (const simEvent of event.data.events) {
      if (simEvent.type === 'poll-closed') pollWinners.set(simEvent.data.poll, simEvent.data.winner);
    }
  };
  const unsubscribe = client.bus.on('agent.events', observePolls);
  for (const event of client.bus.history({ prefix: 'agent.events' })) observePolls(event);

  const readTick = options.readTick ?? createTickReader(client.descriptor);
  let closedReason = 'run closed';
  const closeController = new AbortController();
  void client.closed.then((reason) => {
    closedReason = reason;
    closeController.abort();
  });
  const close: CloseState = { signal: closeController.signal, reason: () => closedReason };
  const wait = options.sleep === undefined
    ? (milliseconds: number): Promise<WaitResult<void>> => waitWithTimer(milliseconds, close)
    : (milliseconds: number): Promise<WaitResult<void>> => orClosed(options.sleep!(milliseconds), close);
  const log = options.log ?? console.log;
  const tickPollMs = options.tickPollMs ?? 500;
  const cycleLimit = script.loop ? script.maxCycles ?? Number.POSITIVE_INFINITY : 1;

  try {
    for (let cycle = 1; cycle <= cycleLimit; cycle += 1) {
      for (const phase of script.phases) {
        let plannedTicks: readonly [number, number] | undefined;
        if (phase.durationTicks !== undefined) {
          const current = await orClosed(readTick(), close);
          if (current.kind === 'closed') return stopped(current.reason);
          if (current.value !== undefined) plannedTicks = [current.value, current.value + phase.durationTicks];
        }
        log(`[phases] cycle ${cycle} phase ${phase.name} ${plannedTicks === undefined
          ? `(ms ${phase.durationMs ?? phase.durationTicks! * TICK_MILLIS})`
          : `(ticks ${plannedTicks[0]}→${plannedTicks[1]})`}`);

        const entered = await applyActions(phase.onEnter ?? [], client, pollWinners, close);
        if (entered === 'closed') return stopped(close.reason());
        if (entered === 'stop') return 'stop-action';
        const waited = await waitForPhase(phase, { readTick, wait, tickPollMs, close }, plannedTicks?.[0]);
        if (waited.closed !== undefined) return stopped(waited.closed);
        const exited = await applyActions(phase.onExit ?? [], client, pollWinners, close);
        if (exited === 'closed') return stopped(close.reason());
        if (exited === 'stop') return 'stop-action';
      }
    }
    return 'script-ended';
  } catch (error) {
    // Control shutdown rejects in-flight requests just before `closed` resolves; allow that
    // resolution microtask to classify a normal run stop versus an unannounced socket loss.
    await Promise.resolve();
    if (close.signal.aborted) return stopped(close.reason());
    throw error;
  } finally {
    unsubscribe();
  }
}
