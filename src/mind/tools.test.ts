import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '#protocol';
import { createBus } from '../bus/index.ts';
import type { Mailbox, MindDeps } from '../core/agent.ts';
import type { MemoryRecord, MemoryStore } from '../core/memory.ts';
import type { ModelRegistry } from '../core/model.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { createReflexEngine, FakeView, makeSnapshot } from '../reflex/index.ts';
import { createAgentTools } from './tools.ts';

function makeDeps(options: { team?: string; scan?: JsonValue; canMessage?: MindDeps['canMessage'] } = {}) {
  const bus = createBus();
  const view = new FakeView(makeSnapshot({ tick: 2, lastEventSeq: 2 }));
  const sent: { to: string; text: string }[] = [];
  const mailbox: Mailbox = {
    send(to, text) { sent.push({ to, text }); }, drain: () => [], pending: () => 0
  };
  const rows: MemoryRecord[] = [];
  const memory: MemoryStore = {
    agentId: 'alice',
    async remember(input) {
      const row: MemoryRecord = { id: rows.length + 1, agentId: 'alice', kind: input.kind, text: input.text,
        tags: input.tags ?? [], importance: input.importance ?? 0.5, runId: 'run-test', createdAt: 0, recallCount: 0 };
      rows.push(row); return row;
    },
    async recall(query) { return rows.filter((row) => row.text.includes(query.text) || query.text === '').slice(0, query.limit).map((record) => ({ record, score: 0.9, why: ['fts'] })); },
    async forget(id) { const index = rows.findIndex((row) => row.id === id); if (index < 0) return false; rows.splice(index, 1); return true; },
    async update() { return undefined; }, async recent() { return rows; }, async count() { return rows.length; }, close() {}
  };
  const submissions: string[] = [];
  const deps: MindDeps = {
    agentId: 'alice', spec: { id: 'alice', ...(options.team === undefined ? {} : { team: options.team }) }, view,
    sink: { async submit(intent) { submissions.push(intent.type); return { intent, ok: true, tick: 2, sentAt: 1 }; } },
    reflexes: createReflexEngine({ agentId: 'alice' }), memory,
    models: {} as ModelRegistry, prompts: createPromptLibrary(), bus, mailbox,
    commandTypes: ['walk', 'recover'], deniedCommandTypes: ['move'],
    ...(options.canMessage === undefined ? {} : { canMessage: options.canMessage }),
    worldContext: {}, worldReads: { async scan() { return options.scan ?? [{ name: 'beacon' }]; } },
    mcpReadTools: { names: { description: 'names', inputSchema: { type: 'object' }, async call(args) { return { args: args as JsonValue }; } } },
    wake: { minIntervalMs: 0, heartbeatMs: 10_000, hpAlertFraction: 0.5, maxTurns: 0, maxToolCallsPerWake: 8 },
    context: { maxPromptTokens: 10_000, compactAtTokens: 9_000, keepTurns: 2, recallLimit: 3 },
    onFinished() {}, setState() {}
  };
  let slept = false;
  let finished: { success: boolean; summary: string } | undefined;
  const tools = createAgentTools(deps, {
    endWake() { slept = true; }, finish(success, summary) { finished = { success, summary }; }
  });
  const run = (name: string, args: Record<string, unknown> = {}) => tools.find((tool) => tool.definition.name === name)!.run(args);
  return { deps, tools, run, rows, sent, submissions, get slept() { return slept; }, get finished() { return finished; } };
}

describe('agent tools', () => {
  test('covers observation, world reads, actions, reflexes, memory, messaging, guides, lifecycle, and MCP', async () => {
    const fixture = makeDeps({ team: 'red' });
    expect(await fixture.run('observe')).toHaveProperty('text');
    expect(await fixture.run('scan', { query: 'beacon' })).toEqual([{ name: 'beacon' }]);
    expect(await fixture.run('act', { type: 'walk', data: { dest: { x: 1, z: 1, level: 0 } }, reason: 'go' })).toMatchObject({ ok: true });
    expect(fixture.submissions).toEqual(['walk']);
    expect(await fixture.run('act', { type: 'move', data: {} })).toHaveProperty('error');
    const rule = { id: 'always-note', priority: 1, when: { op: 'true' }, do: [{ kind: 'note', text: 'x' }] };
    expect(await fixture.run('install_rule', { rule })).toMatchObject({ ok: true });
    expect(await fixture.run('list_reflexes')).toHaveProperty('rules');
    expect(await fixture.run('remove_rule', { id: 'always-note' })).toBe(true);
    expect(await fixture.run('start_behaviour', { behaviour: 'wait', params: { ticks: 2 } })).toMatchObject({ ok: true });
    expect(await fixture.run('stop_behaviour')).toBe(true);
    expect(await fixture.run('remember', { kind: 'semantic', text: 'Beacons emit signals.', tags: ['beacon'], importance: 0.8 })).toEqual({ id: 1 });
    expect(await fixture.run('recall', { query: 'Beacons', kinds: ['semantic'], limit: 2 })).toEqual([
      { id: 1, kind: 'semantic', text: 'Beacons emit signals.', score: 0.9 }
    ]);
    expect(await fixture.run('forget', { id: 1 })).toBe(true);
    expect(await fixture.run('send_message', { to: 'coordinator', text: 'ready' })).toMatchObject({ to: 'coordinator:red' });
    expect(await fixture.run('report', { text: 'milestone' })).toMatchObject({ to: 'coordinator:red' });
    expect(fixture.rows[0]).toMatchObject({ kind: 'episodic', importance: 0.6 });
    expect(await fixture.run('guide', { name: 'commands' })).toContain('Commands');
    expect(await fixture.run('guide', { name: 'agent-system' })).toHaveProperty('error');
    expect(await fixture.run('mcp_names', { q: 'x' })).toEqual({ args: { q: 'x' } });
    expect(await fixture.run('sleep', { reason: 'quiet' })).toMatchObject({ sleeping: true });
    expect(fixture.slept).toBe(true);
    expect(await fixture.run('finish', { success: true, summary: 'done' })).toMatchObject({ finished: true });
    expect(fixture.finished).toEqual({ success: true, summary: 'done' });
  });

  test('wait returns a delta and invalid arguments return errors instead of throwing', async () => {
    const fixture = makeDeps();
    expect(await fixture.run('wait', { ticks: 1 })).toEqual({ lines: [], tick: 2 });
    for (const [name, args] of [
      ['scan', {}], ['act', { type: 'walk' }], ['install_rule', { rule: 'bad' }],
      ['remove_rule', {}], ['start_behaviour', { behaviour: 'wait', params: [] }],
      ['remember', { kind: 'bad', text: 'x' }], ['recall', {}], ['forget', { id: 0 }],
      ['send_message', { to: '', text: 'x' }], ['report', {}], ['guide', { name: 4 }],
      ['sleep', { reason: 4 }], ['finish', { success: 'yes', summary: 'x' }]
    ] as const) expect(await fixture.run(name, args as Record<string, unknown>)).toHaveProperty('error');
  });

  test('all results remain at most 4000 serialized characters', async () => {
    const fixture = makeDeps({ scan: { text: '\\"'.repeat(10_000) } });
    const result = await fixture.run('scan', { query: 'x' });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4_000);
    expect(result).toMatchObject({ truncated: true });
  });

  test('team-only policy refuses cross-team DMs but always permits supervisors', async () => {
    const fixture = makeDeps({
      team: 'red',
      canMessage: (_from, to) => to === 'director' || to === 'coordinator:red' || to === 'teammate'
    });
    expect(await fixture.run('send_message', { to: 'rival', text: 'secret' })).toEqual({
      error: 'cross-team messaging is disabled in this run'
    });
    expect(await fixture.run('send_message', { to: 'teammate', text: 'ready' })).toEqual({ sent: true, to: 'teammate' });
    expect(await fixture.run('send_message', { to: 'director', text: 'status' })).toEqual({ sent: true, to: 'director' });
  });
});
