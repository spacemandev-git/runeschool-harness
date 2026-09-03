import type { HarnessBus } from '../core/index.ts';
import type { HarnessRuntime } from '../runtime/orchestrator.ts';

const EXACT = new Set([
  'agent.spawned', 'agent.state', 'agent.goal', 'agent.action', 'agent.finished', 'agent.message'
]);
function visible(type: string): boolean {
  return type.startsWith('run.') || type.startsWith('world.') || type.startsWith('director.')
    || type.startsWith('admin.') || type.startsWith('coordinator.') || type.startsWith('team.') || EXACT.has(type);
}
function summary(data: unknown): string {
  if (typeof data !== 'object' || data === null) return String(data);
  const raw = data as Record<string, unknown>;
  if (typeof raw.message === 'object' && raw.message !== null) {
    const message = raw.message as Record<string, unknown>;
    if (typeof message.role === 'string' && typeof message.content === 'string') {
      return `${message.role} · ${message.content.slice(0, 180)}`;
    }
  }
  if (typeof raw.call === 'object' && raw.call !== null) {
    const call = raw.call as Record<string, unknown>;
    if (typeof call.name === 'string') return `${call.name} · ${raw.ok === true ? 'ok' : 'failed'}`;
  }
  return [raw.agentId, raw.teamId, raw.state, raw.goal, raw.summary, raw.text, raw.message, raw.error]
    .filter((value) => typeof value === 'string').join(' · ') || JSON.stringify(data).slice(0, 240);
}

export async function runHeadless(runtime: HarnessRuntime, bus: HarnessBus): Promise<number> {
  const config = runtime.view.config() as Record<string, unknown>;
  const idleExitMs = typeof config.idleExitMs === 'number' ? config.idleExitMs : 15_000;
  const keepAlive = config.keepAlive === true;
  const maxRunMs = typeof config.maxRunMs === 'number' ? config.maxRunMs : undefined;
  const finished = new Map<string, boolean>();
  for (const event of bus.history({ prefix: 'agent.finished' })) {
    if (event.type === 'agent.finished') finished.set(event.data.agentId, event.data.success);
  }
  let runtimeError = bus.history({ prefix: 'run.error' }).length > 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const terminal = new Promise<void>((resolve) => { done = resolve; });

  function allTerminal(): boolean {
    const agents = runtime.view.agents();
    return agents.length === 0 || agents.every((agent) => ['finished', 'dead', 'errored'].includes(agent.state));
  }
  function armIdle(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (keepAlive) { idleTimer = undefined; return; }
    if (!allTerminal()) { idleTimer = undefined; return; }
    idleTimer = setTimeout(done, idleExitMs);
  }
  function print(event: { readonly type: string; readonly at: number; readonly data: unknown }): void {
    const data = event.data as Record<string, unknown>;
    if (visible(event.type)
      || (event.type === 'model.response' && data.ok === false)
      || (event.type === 'log' && ['warn', 'error'].includes(String(data.level)))) {
      const time = new Date(event.at).toTimeString().slice(0, 8);
      console.log(`${time} ${event.type} ${summary(event.data)}`);
    }
  }
  // The runtime has already started (provisioning, spawning) before this printer attaches: replay.
  let lastPrintedSeq = 0;
  for (const event of bus.history()) { print(event); lastPrintedSeq = event.seq; }
  const unsubscribe = bus.onAny((event) => {
    if (event.seq > lastPrintedSeq) { print(event); lastPrintedSeq = event.seq; }
    if (event.type === 'agent.finished') finished.set(event.data.agentId, event.data.success);
    if (event.type === 'run.error') { runtimeError = true; done(); }
    armIdle();
  });
  if (maxRunMs !== undefined) maxTimer = setTimeout(done, maxRunMs);
  armIdle();
  await Promise.race([terminal, runtime.stopped.then(() => {})]);
  unsubscribe();
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  if (maxTimer !== undefined) clearTimeout(maxTimer);
  if (!(await Promise.race([runtime.stopped.then(() => true), Promise.resolve(false)]))) {
    await runtime.commands.stop(runtimeError ? 'runtime error' : maxTimer !== undefined ? 'headless timeout or terminal state' : 'headless terminal state');
  }
  if (runtimeError) return 1;
  // Exit 0 only when every agent reached `finished` with success; timeouts and dead/errored/idle
  // agents are incomplete runs.
  const agents = runtime.view.agents();
  return agents.every((agent) => agent.state === 'finished' && finished.get(agent.id) === true) ? 0 : 2;
}
