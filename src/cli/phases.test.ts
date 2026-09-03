import { describe, expect, test } from 'bun:test';
import type { SimEvent } from '#protocol';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBus } from '../bus/index.ts';
import type { AgentSummary, TeamSummary } from '../core/runtime.ts';
import { parseRunConfig, PHASES_HELP } from './config.ts';
import {
  ControlSocketLossError, resolveSelector, runPhaseScript, validatePhaseScript,
  type PhaseControlClient, type PhaseScript,
} from './phases.ts';

const agents: readonly AgentSummary[] = [
  {
    id: 'alice', displayName: 'Alice', tag: 'alice', entity: 11, team: 'village', state: 'idle',
    model: 'fake', activity: 'idle', turns: 0,
  },
  {
    id: 'wolf', displayName: 'Wolf', tag: 'wolf', entity: 22, team: 'afflicted', state: 'idle',
    model: 'fake', activity: 'idle', turns: 0,
  },
];

const teams: readonly TeamSummary[] = [
  { id: 'village', mission: 'survive', agents: ['alice'], coordinatorModel: 'fake' },
  { id: 'afflicted', mission: 'hunt', agents: ['wolf'], coordinatorModel: 'fake' },
];

function fakeClient(calls: string[], closed: Promise<string> = new Promise(() => undefined)): PhaseControlClient {
  const bus = createBus();
  return {
    descriptor: {
      runId: 'run', pid: 1, socketPath: '/tmp/run.sock', startedAt: 1,
      mcpUrl: 'http://localhost:7800/mcp', instanceId: 'instance-1',
    },
    view: { agents: () => agents, teams: () => teams },
    commands: {
      pauseAgent(agent, reason, options): void { calls.push(`pause:${agent}:${reason}:${String(options?.blind)}`); },
      resumeAgent(agent): void { calls.push(`resume:${agent}`); },
      async agentSay(agent, text): Promise<void> { calls.push(`message:${agent}:${text}`); },
      async directorSay(text): Promise<void> { calls.push(`director:${text}`); },
      async agentCommand(agent, command): Promise<null> { calls.push(`command:${agent}:${command}`); return null; },
      async removeAgent(agent, reason): Promise<{ readonly removed: boolean }> { calls.push(`remove:${agent}:${reason ?? ''}`); return { removed: true }; },
      async stop(reason): Promise<void> { calls.push(`stop:${reason}`); },
    },
    bus,
    closed,
  };
}

const instant = { sleep: async (): Promise<void> => undefined, log: (): void => undefined };

describe('phase script validation', () => {
  test('accepts the schema and rejects malformed durations, actions, and selectors', () => {
    expect(validatePhaseScript({ version: 1, phases: [{ name: 'day', durationMs: 10 }] })).toEqual({
      version: 1, phases: [{ name: 'day', durationMs: 10 }],
    });
    expect(() => validatePhaseScript({ version: 2, phases: [] })).toThrow('version must be 1');
    expect(() => validatePhaseScript({ version: 1, phases: [{ name: 'x', durationMs: 1, durationTicks: 1 }] })).toThrow('exactly one');
    expect(() => validatePhaseScript({ version: 1, phases: [{ name: 'x', durationMs: 1, onEnter: [{ kind: 'dance' }] }] })).toThrow('not supported');
    expect(() => validatePhaseScript({
      version: 1, phases: [{ name: 'x', durationMs: 1, onEnter: [{ kind: 'resume', select: { all: true, team: 'x' } }] }],
    })).toThrow('exactly one selector');
  });

  test('parses phases CLI help and target options', () => {
    expect(parseRunConfig(['phases', '--help'], {})).toEqual({ help: PHASES_HELP });
    expect(parseRunConfig(['phases', 'script.json', '--target', 'run-1', '--log-dir', '/tmp/runs'], {})).toEqual({
      subcommand: { name: 'phases', scriptPath: 'script.json', target: 'run-1', logDir: '/tmp/runs' },
    });
  });

  test('loads both checked-in examples', () => {
    for (const name of ['long-night.json', 'beacons.json']) {
      const path = resolve(import.meta.dir, `../../scripts/phases/${name}`);
      expect(validatePhaseScript(JSON.parse(readFileSync(path, 'utf8')) as unknown).phases.length).toBeGreaterThan(0);
    }
  });
});

describe('selector resolution', () => {
  test('resolves agents, teams, all agents, and a poll winner entity', () => {
    const snapshot = { agents, teams };
    expect(resolveSelector({ agents: ['wolf', 'alice', 'wolf'] }, snapshot, new Map())).toEqual(['wolf', 'alice']);
    expect(resolveSelector({ team: 'village' }, snapshot, new Map())).toEqual(['alice']);
    expect(resolveSelector({ all: true }, snapshot, new Map())).toEqual(['alice', 'wolf']);
    expect(resolveSelector({ pollWinner: 'exile' }, snapshot, new Map([['exile', 22]]))).toEqual(['wolf']);
    expect(resolveSelector({ pollWinner: 'exile' }, snapshot, new Map([['exile', null]]))).toEqual([]);
    expect(() => resolveSelector({ team: 'missing' }, snapshot, new Map())).toThrow("unknown team 'missing'");
  });
});

describe('phase execution', () => {
  test('orders one phase onExit before the next phase onEnter', async () => {
    const calls: string[] = [];
    const script = validatePhaseScript({
      version: 1,
      phases: [
        { name: 'night', durationMs: 1, onEnter: [{ kind: 'director', text: 'night-enter' }], onExit: [{ kind: 'director', text: 'night-exit' }] },
        { name: 'day', durationMs: 1, onEnter: [{ kind: 'director', text: 'day-enter' }] },
      ],
    });
    expect(await runPhaseScript(script, fakeClient(calls), instant)).toBe('script-ended');
    expect(calls).toEqual(['director:night-enter', 'director:night-exit', 'director:day-enter']);
  });

  test('loops only through maxCycles', async () => {
    const calls: string[] = [];
    const script: PhaseScript = {
      version: 1, loop: true, maxCycles: 3,
      phases: [{ name: 'pulse', durationMs: 1, onEnter: [{ kind: 'director', text: 'pulse' }] }],
    };
    await runPhaseScript(script, fakeClient(calls), instant);
    expect(calls).toEqual(['director:pulse', 'director:pulse', 'director:pulse']);
  });

  test('waits for the target tick and logs the planned tick range', async () => {
    const ticks = [600, 650, 700];
    const lines: string[] = [];
    const script: PhaseScript = { version: 1, phases: [{ name: 'night', durationTicks: 100 }] };
    await runPhaseScript(script, fakeClient([]), {
      readTick: async () => ticks.shift(),
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual(['[phases] cycle 1 phase night (ticks 600→700)']);
    expect(ticks).toEqual([]);
  });

  test('remembers the latest replayed poll winner and removes its agent', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const poll = (winner: number): SimEvent => ({
      type: 'poll-closed', tick: 50, seq: winner,
      data: { poll: 'exile', winner, reason: 'quorum' },
    });
    client.bus.on('agent.events', () => undefined);
    (client.bus as ReturnType<typeof createBus>).emit('agent.events', { agentId: 'alice', events: [poll(11), poll(22)] });
    const script = validatePhaseScript({
      version: 1,
      phases: [{ name: 'exile', durationMs: 1, onEnter: [{ kind: 'remove', select: { pollWinner: 'exile' }, reason: 'vote' }] }],
    });
    await runPhaseScript(script, client, instant);
    expect(calls).toEqual(['remove:wolf:vote']);
  });

  test('classifies an unannounced socket close as failure', async () => {
    const script: PhaseScript = { version: 1, phases: [{ name: 'day', durationMs: 10 }] };
    await expect(runPhaseScript(script, fakeClient([], Promise.resolve('connection lost')), {
      sleep: async () => await new Promise(() => undefined), log: () => undefined,
    })).rejects.toBeInstanceOf(ControlSocketLossError);
  });
});
