import type { TileCoord } from '#protocol';
import type { AgentSpec } from '../../core/agent.ts';
import type { HarnessBus } from '../../core/bus.ts';
import type { ChatMessage, UsageByKey } from '../../core/model.ts';
import type { WorldSnapshot, PerceptDelta } from '../../core/percept.ts';
import type { ReflexEngineState } from '../../core/reflex.ts';
import type { AgentSummary, RuntimeCommands, RuntimeView, TeamSummary } from '../../core/runtime.ts';
import type { AgentState } from '../../core/types.ts';

interface MutableAgent {
  id: string;
  displayName: string;
  tag: string;
  entity: number;
  team?: string;
  state: AgentState;
  goal?: string;
  model: string;
  hp: { current: number; max: number };
  at: TileCoord;
  activity: string;
  behaviour?: string;
  lastWakeAt?: number;
  turns: number;
  transcript: ChatMessage[];
  snapshot: WorldSnapshot;
  reflexes: ReflexEngineState;
}

export interface FakeRuntime {
  readonly view: RuntimeView;
  readonly commands: RuntimeCommands;
  start(): void;
  stop(): void;
}

function makeSnapshot(id: string, displayName: string, entity: number, at: TileCoord, hp: { current: number; max: number }): WorldSnapshot {
  return {
    instanceId: 'inst-fake', tick: 0, wallTime: 0, radius: 12,
    self: {
      entity, tag: id, displayName, at, hp,
      combat: { inCombat: false, attackedBy: [], autoRetaliate: true },
      activity: { kind: 'idle' }, dead: false,
    },
    inventory: [
      { slot: 0, item: 1, name: 'Rations', amount: 3 },
      { slot: 1, item: 2, name: 'Credits', amount: id === 'miner' ? 24 : 10 },
    ],
    inventoryFree: 26,
    equipment: id === 'hero' ? { tool: { item: 3, name: 'Survey tool' } } : {},
    skills: { navigation: { level: id === 'hero' ? 5 : 1, xp: id === 'hero' ? 388 : 0 }, collection: { level: id === 'miner' ? 7 : 1, xp: id === 'miner' ? 650 : 0 }, endurance: { level: 10, xp: 1154 } },
    nearby: [], groundItems: [],
    nodes: id === 'miner' ? [{ id: 'sample-1', at: { x: at.x + 1, z: at.z, level: 0 }, distance: 1, name: 'Sample deposit', skill: 'collection', requiredLevel: 1, depleted: false }] : [],
    stations: [], heatSources: [],
    objectives: [{ id: 'explore', description: 'Explore the training grounds', outcome: 'progress', complete: false, progress: [{ path: 'steps', kind: 'counter', current: 0, target: 10, satisfied: false }] }],
    won: false, lost: false, dialogue: { active: false }, chat: [], lastEventSeq: 0, resyncedTick: 0,
  };
}

function makeAgent(id: string, displayName: string, entity: number, team: string | undefined, x: number, z: number, goal: string): MutableAgent {
  const at = { x, z, level: 0 };
  const hp = { current: 10, max: 10 };
  return {
    id, displayName, tag: id, entity, ...(team === undefined ? {} : { team }), state: 'acting', goal,
    model: 'fake-agent-v1', hp, at, activity: id === 'miner' ? 'acting' : 'walking',
    behaviour: id === 'miner' ? 'sample-loop' : 'walk-to', turns: 0, transcript: [],
    snapshot: makeSnapshot(id, displayName, entity, at, hp),
    reflexes: {
      rules: [{ id: 'recover-low', description: 'Recover below half health', priority: 100, when: { op: 'lt', ref: 'self.hp.fraction', value: 0.5 }, do: [{ kind: 'command', type: 'recover', data: {} }], enabled: true, fireCount: 0 }],
      behaviour: { instance: `${id}-behaviour-1`, id: id === 'miner' ? 'sample-loop' : 'walk-to', params: {}, startedTick: 0, description: id === 'miner' ? 'collecting a nearby sample' : 'walking the patrol route' },
      queue: [],
    },
  };
}

export function createFakeRuntime(bus: HarnessBus, options: { readonly seed?: number } = {}): FakeRuntime {
  const seed = options.seed ?? 1;
  let randomState = seed >>> 0;
  const random = (): number => {
    randomState = (Math.imul(1_664_525, randomState) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const startedAt = 1_700_000_000_000 + seed;
  const runId = `run-fake-${seed}`;
  let tick = 0;
  let nextEntity = 104;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const agents = new Map<string, MutableAgent>([
    ['hero', makeAgent('hero', 'Hero', 101, 'alpha', 12, 8, 'Coordinate the team')],
    ['scout', makeAgent('scout', 'Scout', 102, 'alpha', 14, 9, 'Map the grounds')],
    ['miner', makeAgent('miner', 'Miner', 103, undefined, 18, 12, 'Collect a sample')],
  ]);
  const director: ChatMessage[] = [{ role: 'assistant', content: '**World provisioned.** Three agents are online.' }];
  const admin: ChatMessage[] = [{ role: 'assistant', content: '**Admin ready.** I can make changes to the world.' }];
  const coordinators = new Map<string, ChatMessage[]>([['alpha', []]]);
  let directorModel = 'fake-director-v1';
  let agentDefaultModel = 'fake-agent-v1';
  const coordinatorModels = new Map<string, string>([['alpha', 'fake-coordinator-v1']]);
  const usage = new Map<string, { calls: number; prompt: number; completion: number; errors: number }>();
  let lastReport = 'Hero and Scout are moving to their objectives.';

  const summaries = (): AgentSummary[] => [...agents.values()].map((agent) => ({
    id: agent.id, displayName: agent.displayName, tag: agent.tag, entity: agent.entity,
    ...(agent.team === undefined ? {} : { team: agent.team }), state: agent.state,
    ...(agent.goal === undefined ? {} : { goal: agent.goal }), model: agent.model, hp: { ...agent.hp }, at: { ...agent.at },
    activity: agent.activity, ...(agent.behaviour === undefined ? {} : { behaviour: agent.behaviour }),
    ...(agent.lastWakeAt === undefined ? {} : { lastWakeAt: agent.lastWakeAt }), turns: agent.turns,
  }));
  const teams = (): TeamSummary[] => [{ id: 'alpha', mission: 'Explore safely and report useful discoveries.', agents: ['hero', 'scout'], coordinatorModel: coordinatorModels.get('alpha') ?? 'fake-coordinator-v1', lastReport }];
  const usageRows = (): UsageByKey[] => [...usage].map(([key, value]) => ({ key, calls: value.calls, usage: { promptTokens: value.prompt, completionTokens: value.completion, totalTokens: value.prompt + value.completion }, errors: value.errors }));

  const view: RuntimeView = {
    runId,
    startedAt,
    get instance() { return { id: 'inst-fake', httpUrl: 'http://127.0.0.1:7780', watchUrl: 'http://127.0.0.1:5173/play/inst-fake', kind: 'sandbox', tick }; },
    agents: summaries,
    teams,
    agentSnapshot(id) { return agents.get(id)?.snapshot; },
    agentReflexes(id) { return agents.get(id)?.reflexes; },
    agentTranscript(id) { return agents.get(id)?.transcript.slice() ?? []; },
    directorTranscript() { return director.slice(); },
    adminTranscript() { return admin.slice(); },
    coordinatorTranscript(team) { return coordinators.get(team)?.slice() ?? []; },
    usage: usageRows,
    config() {
      return {
        fake: true, seed, credentials: '[redacted]', pulseMs: 600,
        models: {
          director: directorModel,
          admin: 'fake-admin-v1',
          agentDefault: agentDefaultModel,
          coordinators: Object.fromEntries(coordinatorModels),
          agents: Object.fromEntries([...agents].map(([id, agent]) => [id, agent.model]))
        }
      };
    },
  };

  const later = (delay: number, callback: () => void): Promise<void> => new Promise((resolve) => {
    const handle = setTimeout(() => { pending.delete(handle); if (!stopped) callback(); resolve(); }, delay);
    pending.add(handle);
  });
  const getAgent = (id: string): MutableAgent => {
    const agent = agents.get(id);
    if (agent === undefined) throw new Error(`unknown agent: ${id}`);
    return agent;
  };
  const commands: RuntimeCommands = {
    async adminSay(text) {
      const user: ChatMessage = { role: 'user', content: text };
      admin.push(user);
      bus.emit('admin.turn', { message: user });
      await later(300, () => {
        bus.emit('admin.tool', {
          call: { id: 'call_fake', name: 'place_beacons', arguments: '{"kind":"beacon","count":2,"near_agent":"hero"}' },
          result: { placed: [{ kind: 'beacon', entity: 201, at: { x: 13, z: 8, level: 0 } }, { kind: 'beacon', entity: 202, at: { x: 12, z: 9, level: 0 } }] },
          ok: true,
          durationMs: 12
        });
        const message: ChatMessage = { role: 'assistant', content: `Admin echo: ${text}` };
        admin.push(message);
        bus.emit('admin.turn', { message });
      });
    },
    async directorSay(text) {
      const user: ChatMessage = { role: 'user', content: text };
      director.push(user);
      bus.emit('director.turn', { message: user });
      await later(300, () => {
        const message: ChatMessage = { role: 'assistant', content: `Director echo: ${text}` };
        director.push(message);
        const entry = usage.get('director') ?? { calls: 0, prompt: 0, completion: 0, errors: 0 };
        entry.calls += 1; entry.prompt += Math.max(1, Math.ceil(text.length / 4)); entry.completion += Math.max(1, Math.ceil(text.length / 5)); usage.set('director', entry);
        bus.emit('director.turn', { message, usage: { promptTokens: entry.prompt, completionTokens: entry.completion, totalTokens: entry.prompt + entry.completion } });
      });
    },
    async agentSay(agentId, text) {
      const agent = getAgent(agentId);
      bus.emit('agent.message', { from: 'operator', to: agentId, text });
      agent.lastWakeAt = startedAt + tick * 600;
      bus.emit('agent.mind.wake', { agentId, reasons: ['operator'], note: text });
      await later(100, () => {
        const message: ChatMessage = { role: 'assistant', content: `Acknowledged: ${text}` };
        agent.transcript.push(message);
        agent.turns += 1;
        bus.emit('agent.mind.turn', { agentId, turn: agent.turns, message });
      });
    },
    async coordinatorSay(team, text) {
      const transcript = coordinators.get(team);
      if (transcript === undefined) throw new Error(`unknown team: ${team}`);
      const user: ChatMessage = { role: 'user', content: text };
      transcript.push(user);
      lastReport = text;
      bus.emit('coordinator.turn', { teamId: team, message: user });
      bus.emit('team.report', { teamId: team, text });
    },
    async setAgentGoal(agentId, goal) {
      const agent = getAgent(agentId);
      agent.goal = goal;
      bus.emit('agent.goal', { agentId, goal, from: 'operator' });
      bus.emit('agent.mind.wake', { agentId, reasons: ['goal-assigned'], note: goal });
    },
    pauseAgent(agentId) {
      const agent = getAgent(agentId); agent.state = 'paused';
      bus.emit('agent.state', { agentId, state: 'paused', detail: 'operator' });
    },
    resumeAgent(agentId) {
      const agent = getAgent(agentId); agent.state = 'acting';
      bus.emit('agent.state', { agentId, state: 'acting', detail: 'operator' });
      bus.emit('agent.mind.wake', { agentId, reasons: ['resumed'] });
    },
    async agentCommand(agentId, type, data) {
      const agent = getAgent(agentId);
      const outcome = { intent: { type, data, source: { kind: 'operator' as const } }, ok: true, tick, sentAt: startedAt + tick * 600 };
      bus.emit('agent.action', { agentId, outcome });
      return { ok: true, tick, entity: agent.entity };
    },
    async spawnAgent(spec: AgentSpec) {
      if (agents.has(spec.id)) throw new Error(`agent already exists: ${spec.id}`);
      const at = spec.spawn?.at ?? { x: 3220, z: 3220, level: 0 };
      const agent = makeAgent(spec.id, spec.displayName ?? spec.id, nextEntity++, spec.team, at.x, at.z, spec.goal ?? 'Await instructions');
      agent.model = agentDefaultModel;
      agents.set(agent.id, agent);
      bus.emit('agent.spawned', { agentId: agent.id, tag: agent.tag, entity: agent.entity, ...(agent.team === undefined ? {} : { team: agent.team }), displayName: agent.displayName });
      bus.emit('agent.snapshot', { agentId: agent.id, snapshot: agent.snapshot });
    },
    setModel(selection) {
      if (selection.role === 'director') {
        directorModel = selection.model;
      } else if (selection.role === 'agent-default') {
        agentDefaultModel = selection.model;
      } else if (selection.role === 'coordinator') {
        if (!coordinators.has(selection.team)) throw new Error(`unknown team: ${selection.team}`);
        coordinatorModels.set(selection.team, selection.model);
      } else {
        getAgent(selection.agent).model = selection.model;
      }
      bus.emit('log', {
        level: 'info', scope: 'models',
        message: `selected ${selection.model} for ${selection.role}`
      });
    },
    async stop(reason) {
      stopTimers();
      bus.emit('run.finish', { runId, summary: `fake runtime stopped: ${reason}`, ok: true });
    },
  };

  const pulse = (): void => {
    tick += 1;
    for (const agent of agents.values()) {
      if (agent.state === 'paused' || agent.state === 'finished') continue;
      const from = { ...agent.at };
      const step = random() < 0.5 ? -1 : 1;
      agent.at = { x: agent.at.x + step, z: agent.at.z + (random() < 0.4 ? step : 0), level: 0 };
      if (random() < 0.18) agent.hp.current = Math.max(1, agent.hp.current - 1);
      else if (random() < 0.12) agent.hp.current = Math.min(agent.hp.max, agent.hp.current + 1);
      const self = { ...agent.snapshot.self, at: agent.at, hp: { ...agent.hp }, activity: { kind: 'walking' as const, dest: { x: agent.at.x + 1, z: agent.at.z, level: 0 }, since: tick } };
      agent.snapshot = { ...agent.snapshot, tick, wallTime: tick * 600, self, lastEventSeq: tick, resyncedTick: tick };
      bus.emit('agent.snapshot', { agentId: agent.id, snapshot: agent.snapshot });
      const lines = [`move: ${from.x},${from.z} → ${agent.at.x},${agent.at.z}`];
      const extra = 1 + Math.floor(random() * 5);
      for (let index = 1; index < extra; index += 1) lines.push(index % 2 === 0 ? `world: tick ${tick} is calm` : `xp: ${agent.id} surveys the area`);
      const delta: PerceptDelta = {
        fromSeq: tick - 1, toSeq: tick, fromTick: tick - 1, toTick: tick,
        moved: { from, to: agent.at }, xpGained: [], levelUps: [], itemsGained: [], itemsLost: [], entered: [], left: [], deaths: [], damageTaken: 0, damageDealt: 0,
        groundItemsAppeared: [], objectivesChanged: [], rejections: [], messages: [], lines, events: [],
      };
      bus.emit('agent.delta', { agentId: agent.id, delta });
      if (tick % 3 === 0) bus.emit('agent.action', { agentId: agent.id, outcome: { intent: { type: 'walk', data: { x: agent.at.x, z: agent.at.z }, source: { kind: 'behaviour', id: 'walk-to', instance: `${agent.id}-behaviour-1` } }, ok: true, tick, sentAt: startedAt + tick * 600 } });
      if (tick % 5 === 0) bus.emit('agent.reflex', { agentId: agent.id, line: 'eat-low checked: no action', state: agent.reflexes });
      if (tick % 4 === 0) {
        agent.turns += 1; agent.lastWakeAt = startedAt + tick * 600;
        bus.emit('agent.mind.wake', { agentId: agent.id, reasons: ['behaviour-finished'], note: 'patrol leg complete' });
        const message: ChatMessage = { role: 'assistant', content: `Turn ${agent.turns}: continuing **${agent.goal ?? 'current task'}**.` };
        agent.transcript.push(message);
        bus.emit('agent.mind.turn', { agentId: agent.id, turn: agent.turns, message, usage: { promptTokens: 42, completionTokens: 14, totalTokens: 56 } });
        bus.emit('model.response', { role: 'agent', agentId: agent.id, model: agent.model, usage: { promptTokens: 42, completionTokens: 14, totalTokens: 56 }, latencyMs: 80, ok: true });
        const entry = usage.get(`agent:${agent.id}`) ?? { calls: 0, prompt: 0, completion: 0, errors: 0 };
        entry.calls += 1; entry.prompt += 42; entry.completion += 14; usage.set(`agent:${agent.id}`, entry);
      }
      if (tick % 7 === 0) bus.emit('agent.mind.tool', { agentId: agent.id, call: { id: `tool-${tick}`, name: 'observe', arguments: '{"radius":8}' }, result: { tick, nearby: 0 }, ok: true, durationMs: 12 });
    }
    if (tick % 6 === 0) bus.emit('agent.message', { from: 'scout', to: 'hero', text: `Sector report at tick ${tick}: clear.` });
  };

  function stopTimers(): void {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const handle of pending) clearTimeout(handle);
    pending.clear();
  }

  return {
    view,
    commands,
    start() {
      if (timer !== undefined) return;
      stopped = false;
      bus.emit('run.start', { runId, config: view.config() });
      bus.emit('world.provisioned', { instanceId: 'inst-fake', httpUrl: 'http://127.0.0.1:7780', wsUrl: 'ws://127.0.0.1:7780/ws', kind: 'sandbox', watchUrl: 'http://127.0.0.1:5173/play/inst-fake' });
      for (const agent of agents.values()) bus.emit('agent.spawned', { agentId: agent.id, tag: agent.tag, entity: agent.entity, ...(agent.team === undefined ? {} : { team: agent.team }), displayName: agent.displayName });
      bus.emit('team.created', { teamId: 'alpha', agents: ['hero', 'scout'], mission: teams()[0]?.mission ?? '' });
      bus.emit('admin.report', { text: 'Fake world controls are online.' });
      timer = setInterval(pulse, 600);
    },
    stop: stopTimers,
  };
}
