import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedControlDescriptor } from './subcommands.ts';
import { formatPs, harnessCommand, readLogTail, selectControlDescriptor } from './subcommands.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

const live: ListedControlDescriptor = {
  runId: 'run-live', pid: 20, live: true, path: '/runs/run-live.control.json',
  socketPath: '/runs/run-live.sock', startedAt: 2_000, mcpUrl: 'http://localhost/mcp',
  instanceId: 'inst-2', logPath: '/runs/run-live.log',
};
const stale: ListedControlDescriptor = {
  runId: 'run-stale', pid: 10, live: false, path: '/runs/run-stale.control.json',
  socketPath: '/runs/run-stale.sock', startedAt: 1_000, mcpUrl: 'http://localhost/mcp',
};

test('ps formatting includes live and stale rows', () => {
  const output = formatPs([stale, live]);
  expect(output).toContain('RUN ID');
  expect(output).toContain('run-live');
  expect(output).toContain('live');
  expect(output).toContain('run-stale');
  expect(output).toContain('stale');
});

test('latest selects the most recently started live descriptor', () => {
  const older = { ...live, runId: 'run-older', startedAt: 500 };
  expect(selectControlDescriptor([older, stale, live], 'latest')).toBe(live);
  expect(() => selectControlDescriptor([stale], 'latest')).toThrow('no live');
  expect(() => selectControlDescriptor([stale], 'run-stale')).toThrow('ps --prune');
});

test('logs tail returns the final 40 lines', () => {
  const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const output = readLogTail('/runs/run-live.log', 40, () => text);
  expect(output.split('\n')).toHaveLength(40);
  expect(output).toStartWith('line 11');
  expect(output).toEndWith('line 50');
});

test('harness command uses the package script only from the standalone repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'harness-command-')); dirs.push(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@runeschool/harness' }));
  expect(harnessCommand('attach run-1', repo)).toBe('bun run start attach run-1');

  const elsewhere = mkdtempSync(join(tmpdir(), 'harness-command-')); dirs.push(elsewhere);
  mkdirSync(join(elsewhere, 'harness'));
  writeFileSync(join(elsewhere, 'harness', 'package.json'), JSON.stringify({ name: '@runeschool/harness' }));
  expect(harnessCommand('ps', elsewhere)).toMatch(/^bun \/.*\/src\/main\.ts ps$/);
});
