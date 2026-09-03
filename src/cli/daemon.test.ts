import { expect, test } from 'bun:test';
import type { ControlDescriptor } from '../core/control.ts';
import { parseRunConfig } from './config.ts';
import { startDaemon } from './daemon.ts';

function daemonConfig() {
  const parsed = parseRunConfig(['--daemon', '--run-id', 'daemon-test', '--log-dir', '/tmp/daemon-test'], {});
  if ('help' in parsed || 'subcommand' in parsed) throw new Error('unexpected parse result');
  return parsed;
}

test('startDaemon prints the run and attach hint after a live descriptor appears', async () => {
  const output: string[] = [];
  const descriptor: ControlDescriptor & { live: boolean; path: string } = {
    runId: 'daemon-test', pid: 123, live: true, path: '/tmp/daemon-test/daemon-test.control.json',
    socketPath: '/tmp/daemon-test/daemon-test.sock', startedAt: 1, mcpUrl: 'http://localhost/mcp',
  };
  const code = await startDaemon(daemonConfig(), ['--daemon', '--run-id', 'daemon-test'], {
    openLog: () => 9,
    closeLog: () => {},
    spawn: () => ({ pid: 123, exitCode: null, unref() {} }),
    listControlDescriptors: async () => [descriptor],
    print: (line) => output.push(line),
  });
  expect(code).toBe(0);
  expect(output.join('\n')).toContain('run daemon-test started · pid 123');
  expect(output.join('\n')).toMatch(/attach: bun (run start|run harness --|\S+main\.ts) attach daemon-test/);
});

test('startDaemon reports the log tail when the child exits first', async () => {
  const errors: string[] = [];
  const code = await startDaemon(daemonConfig(), ['--daemon'], {
    openLog: () => 9,
    closeLog: () => {},
    spawn: () => ({ pid: 124, exitCode: 1, unref() {} }),
    listControlDescriptors: async () => [],
    readLog: () => 'first\nlast failure\n',
    printError: (line) => errors.push(line),
  });
  expect(code).toBe(1);
  expect(errors.join('\n')).toContain('failed to start (exit 1)');
  expect(errors.join('\n')).toContain('last failure');
});
