import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { listControlDescriptors } from '../control/index.ts';
import type { ControlDescriptor } from '../core/control.ts';
import type { ParsedRunConfig } from './config.ts';
import { harnessCommand } from './subcommands.ts';

type ListedDescriptor = ControlDescriptor & { readonly live: boolean; readonly path: string };
type DaemonChild = Pick<ChildProcess, 'pid' | 'exitCode' | 'unref'>;

export interface DaemonDeps {
  readonly spawn?: (command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => DaemonChild;
  readonly listControlDescriptors?: (logDir: string) => Promise<readonly ListedDescriptor[]>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly print?: (line: string) => void;
  readonly printError?: (line: string) => void;
  readonly openLog?: (path: string) => number;
  readonly closeLog?: (fd: number) => void;
  readonly readLog?: (path: string) => string;
}

function withoutDaemon(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--daemon');
}

function tail(text: string, count = 40): string {
  return text.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1).slice(-count).join('\n');
}

export async function startDaemon(parsed: ParsedRunConfig, argv: readonly string[], deps: DaemonDeps = {}): Promise<number> {
  mkdirSync(parsed.logDir, { recursive: true });
  const logPath = resolve(parsed.logDir, `${parsed.runId}.log`);
  const openLog = deps.openLog ?? ((path: string): number => {
    const fd = openSync(path, 'a', 0o600);
    chmodSync(path, 0o600);
    return fd;
  });
  const fd = openLog(logPath);
  const childArgv = [
    resolve(import.meta.dir, '../main.ts'),
    ...withoutDaemon(argv),
    '--headless', '--serve', '--run-id', parsed.runId,
    ...(!argv.includes('--idle-exit-ms') ? ['--keep-alive'] : []),
    '--daemon-log', logPath,
  ];
  let child: DaemonChild;
  try {
    const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
    child = spawn(process.execPath, childArgv, { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
  } finally {
    (deps.closeLog ?? closeSync)(fd);
  }

  const list = deps.listControlDescriptors ?? listControlDescriptors;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const deadline = now() + 30_000;
  while (now() < deadline) {
    if (child.exitCode !== null) {
      const readLog = deps.readLog ?? ((path: string) => readFileSync(path, 'utf8'));
      let logTail = '';
      try { logTail = tail(readLog(logPath)); } catch { /* the child may have failed before writing */ }
      (deps.printError ?? console.error)(`run ${parsed.runId} failed to start (exit ${child.exitCode})`);
      if (logTail.length > 0) (deps.printError ?? console.error)(logTail);
      return 1;
    }
    try {
      const descriptor = (await list(parsed.logDir)).find((entry) => entry.runId === parsed.runId && entry.live);
      if (descriptor !== undefined) {
        const pid = child.pid ?? descriptor.pid;
        (deps.print ?? console.log)(`run ${parsed.runId} started · pid ${pid} · log ${logPath}`);
        (deps.print ?? console.log)(`attach: ${harnessCommand(`attach ${parsed.runId}`)}`);
        return 0;
      }
    } catch { /* the control server may not have created its directory yet */ }
    await sleep(100);
  }
  (deps.printError ?? console.error)(`run ${parsed.runId} did not publish a live control descriptor within 30s; log ${logPath}`);
  return 1;
}
