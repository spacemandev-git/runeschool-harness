import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HELP, deriveUiUrl, parseRunConfig } from './config.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

describe('run config', () => {
  test('returns help and parses shorthand with scenario slot defaults', () => {
    expect(parseRunConfig(['--help'], {})).toEqual({ help: HELP });
    const config = parseRunConfig(['Walk east'], {});
    if ('help' in config || 'subcommand' in config) throw new Error('unexpected help');
    expect(config.world).toMatchObject({ kind: 'scenario', name: 'goblin-menace', seed: 1 });
    expect(config.agents[0]).toMatchObject({ id: 'agent', goal: 'Walk east', useExistingSlot: true, reflexPreset: 'melee-basic' });
    expect(config.agents[0]?.tag).toBeUndefined();
    expect(config.uiUrl).toBe('http://localhost:5300');
    expect(config.logDir).toBe(resolve(import.meta.dir, '../../runs'));
    expect(config.dataDir).toBe(resolve(import.meta.dir, '../../data'));
  });

  test('leaves the first scenario slot unresolved and tags later agents by id', () => {
    const config = parseRunConfig([
      '--scenario', 'goblin-ambush', '--agent', 'hero=Survive', '--agent', 'helper'
    ], {});
    if ('help' in config || 'subcommand' in config) throw new Error('unexpected help');
    expect(config.agents[0]).toMatchObject({ id: 'hero', useExistingSlot: true });
    expect(config.agents[0]?.tag).toBeUndefined();
    expect(config.agents[1]).toMatchObject({ id: 'helper', tag: 'helper' });
  });

  test('derives MCP from the backend and lets the CLI override environment', () => {
    const derived = parseRunConfig([], { RUNESCHOOL_API_BACKEND: 'https://api.runeschool.dev/' });
    if ('help' in derived || 'subcommand' in derived) throw new Error('unexpected help');
    expect(derived.mcpUrl).toBe('https://api.runeschool.dev/mcp');

    const overridden = parseRunConfig([
      '--mcp-url', 'https://cli.example/mcp/', '--ui-url', 'https://cli.example/ui/'
    ], {
      RUNESCHOOL_MCP_URL: 'https://env.example/mcp',
      RUNESCHOOL_UI_URL: 'https://env.example/ui'
    });
    if ('help' in overridden || 'subcommand' in overridden) throw new Error('unexpected help');
    expect(overridden.mcpUrl).toBe('https://cli.example/mcp');
    expect(overridden.uiUrl).toBe('https://cli.example/ui');
  });

  test('parses the shared hosted world and rejects incompatible world flags', () => {
    const config = parseRunConfig(['--hosted', '--agent', 'bob=Duel alice'], {
      RUNESCHOOL_API_BACKEND: 'https://game.example/api/',
    });
    if ('help' in config || 'subcommand' in config) throw new Error('unexpected help');
    expect(config.world).toEqual({ kind: 'hosted', backendUrl: 'https://game.example/api' });
    expect(config.agents[0]).toMatchObject({ id: 'bob', goal: 'Duel alice' });
    expect(config.agents[0]?.tag).toBeUndefined();
    expect(() => parseRunConfig(['--hosted', '--pvp'], {})).toThrow(
      '--pvp is only valid with --scenario or --sandbox',
    );
    expect(() => parseRunConfig(['--hosted', '--scenario', 'arena-island'], {})).toThrow(
      '--hosted and --scenario are mutually exclusive',
    );
  });

  test('parses world, agent, team, operation, and URL flags', () => {
    const config = parseRunConfig([
      '--sandbox', 'lumbridge', '--seed', '42', '--pvp',
      '--agent', 'miner@slot-a=Mine ore', '--agent', 'banker',
      '--team', 'workers=miner,banker:Gather and bank ore', '--preset', 'skiller',
      '--director', 'coordinate', '--admin', 'spawn goblins', '--headless', '--auto-director',
      '--channels', 'team-only', '--trace-model-messages',
      '--model-config', 'models.json', '--mcp-url', 'https://game.test/mcp/',
      '--ui-url', 'https://ui.test/', '--log-dir', 'logs', '--data-dir', 'data',
      '--max-run-ms', '9000', '--idle-exit-ms', '0'
    ], {});
    if ('help' in config || 'subcommand' in config) throw new Error('unexpected help');
    expect(config).toMatchObject({
      world: { kind: 'sandbox', query: 'lumbridge', seed: 42, pvp: true }, headless: true,
      directorPrompt: 'coordinate', adminPrompt: 'spawn goblins', modelConfigPath: 'models.json', mcpUrl: 'https://game.test/mcp',
      uiUrl: 'https://ui.test', logDir: 'logs', dataDir: 'data', maxRunMs: 9000, idleExitMs: 0,
      autoDirector: true, channels: 'team-only', traceModelMessages: true
    });
    expect(config.agents).toEqual([
      expect.objectContaining({ id: 'miner', tag: 'slot-a', team: 'workers', goal: 'Mine ore', reflexPreset: 'skiller' }),
      expect.objectContaining({ id: 'banker', tag: 'banker', team: 'workers', reflexPreset: 'skiller' })
    ]);
  });

  test('merges agents files and parses resume and attach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-config-')); dirs.push(dir);
    const agentsPath = join(dir, 'agents.json');
    writeFileSync(agentsPath, JSON.stringify({
      agents: [{ id: 'one', privateGoal: true }], teams: [{ id: 't', mission: 'm', agents: ['one'] }],
      channels: 'team-only', traceModelMessages: true
    }));
    const merged = parseRunConfig(['--resume', 'world-1', '--agents', agentsPath, '--agent', 'two'], {});
    if ('help' in merged || 'subcommand' in merged) throw new Error('unexpected help');
    expect(merged.world).toEqual({ kind: 'resume', worldId: 'world-1' });
    expect(merged.agents.map((agent) => agent.id)).toEqual(['one', 'two']);
    expect(merged).toMatchObject({ channels: 'team-only', traceModelMessages: true });

    const attachPath = join(dir, 'attach.json');
    writeFileSync(attachPath, JSON.stringify({ instanceId: 'i', httpUrl: 'http://x/i', wsUrl: 'ws://x/i', adminToken: 'admin-secret', actors: [{ tag: 'hero', entity: 1, token: 'secret' }] }));
    const attached = parseRunConfig(['--attach', attachPath, '--agent', 'hero'], {});
    if ('help' in attached || 'subcommand' in attached || attached.world.kind !== 'attach') throw new Error('unexpected config');
    expect(attached.world.actors[0]?.token).toBe('secret');
    expect(attached.world.adminToken).toBe('admin-secret');

    writeFileSync(attachPath, JSON.stringify({ instanceId: 'i', httpUrl: 'http://x/i', wsUrl: 'ws://x/i', actors: [] }));
    const withoutAdminToken = parseRunConfig(['--attach', attachPath], {});
    if ('help' in withoutAdminToken || 'subcommand' in withoutAdminToken || withoutAdminToken.world.kind !== 'attach') throw new Error('unexpected config');
    expect(withoutAdminToken.world.adminToken).toBeUndefined();

    writeFileSync(attachPath, JSON.stringify({ instanceId: 'i', httpUrl: 'http://x/i', wsUrl: 'ws://x/i', adminToken: ' ', actors: [] }));
    expect(() => parseRunConfig(['--attach', attachPath], {})).toThrow('--attach.adminToken must be a non-empty string');
  });

  test('reports precise conflicts and invalid identities', () => {
    expect(() => parseRunConfig(['--scenario', 'x', '--sandbox', 'y', '--agent', 'a'], {})).toThrow('mutually exclusive');
    expect(() => parseRunConfig(['--agent', 'Bad'], {})).toThrow('must match');
    expect(() => parseRunConfig(['--sandbox', 'x'], {})).toThrow('requires at least one agent');
    expect(deriveUiUrl('https://api.runeschool.dev/mcp')).toBe('https://runeschool.dev');
    expect(() => parseRunConfig(['--agent', 'a', '--channels', 'closed'], {})).toThrow('--channels must be open or team-only');
  });

  test('parses daemon, serving, keep-alive, run id, and hidden daemon log flags', () => {
    const daemon = parseRunConfig(['--daemon', '--run-id', 'ssh-run-1', '--daemon-log', '/tmp/ssh-run.log'], {});
    if ('help' in daemon || 'subcommand' in daemon) throw new Error('unexpected config');
    expect(daemon).toMatchObject({ daemon: true, headless: true, serve: true, keepAlive: true, runId: 'ssh-run-1', daemonLogPath: '/tmp/ssh-run.log' });

    const idleDaemon = parseRunConfig(['--daemon', '--idle-exit-ms', '7'], {});
    if ('help' in idleDaemon || 'subcommand' in idleDaemon) throw new Error('unexpected config');
    expect(idleDaemon.keepAlive).toBe(false);
    const noServe = parseRunConfig(['--no-serve', '--keep-alive'], {});
    if ('help' in noServe || 'subcommand' in noServe) throw new Error('unexpected config');
    expect(noServe).toMatchObject({ serve: false, keepAlive: true });
    expect(() => parseRunConfig(['--run-id', 'Bad_id'], {})).toThrow('must match');
    expect(() => parseRunConfig(['--run-id', 'a'.repeat(65)], {})).toThrow('must match');
  });

  test('parses control subcommands and their options', () => {
    expect(parseRunConfig(['attach', 'latest', '--log-dir', '/tmp/runs'], {})).toEqual({ subcommand: { name: 'attach', target: 'latest', logDir: '/tmp/runs' } });
    expect(parseRunConfig(['ps', '--prune', '--log-dir', '/tmp/runs'], {})).toEqual({ subcommand: { name: 'ps', prune: true, logDir: '/tmp/runs' } });
    expect(parseRunConfig(['stop', 'run-1', '--log-dir', '/tmp/runs'], {})).toEqual({ subcommand: { name: 'stop', target: 'run-1', logDir: '/tmp/runs' } });
    expect(parseRunConfig(['logs', 'latest', '-f', '--log-dir', '/tmp/runs'], {})).toEqual({ subcommand: { name: 'logs', target: 'latest', follow: true, logDir: '/tmp/runs' } });
  });
});
