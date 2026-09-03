import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ControlDescriptor } from '../core/control.ts';
import type { HarnessSubcommand } from './config.ts';
import { connectControl } from '../control/client.ts';
import { runPhaseScript, validatePhaseScript } from './phases.ts';

export type ListedControlDescriptor = ControlDescriptor & { readonly live: boolean; readonly path: string };

function packageName(dir: string): string | undefined {
  try { return (JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string }).name; }
  catch { return undefined; }
}

/**
 * Prefer the package script from this repository and otherwise launch the absolute entry point.
 */
export function harnessCommand(args: string, cwd: string = process.cwd()): string {
  if (packageName(cwd) === '@runeschool/harness') return `bun run start ${args}`;
  return `bun ${resolve(import.meta.dir, '../main.ts')} ${args}`;
}

function cell(value: unknown): string {
  return value === undefined || value === '' ? '—' : String(value);
}

export function formatPs(descriptors: readonly ListedControlDescriptor[]): string {
  const headings = ['RUN ID', 'PID', 'STATE', 'STARTED', 'INSTANCE', 'SOCKET', 'LOG'];
  const rows = descriptors
    .slice()
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((descriptor) => [
      descriptor.runId,
      String(descriptor.pid),
      descriptor.live ? 'live' : 'stale',
      new Date(descriptor.startedAt).toISOString(),
      cell(descriptor.instanceId),
      descriptor.socketPath,
      cell(descriptor.logPath),
    ]);
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: readonly string[]): string => row.map((value, index) => value.padEnd(widths[index]!)).join('  ').trimEnd();
  return [render(headings), ...rows.map(render)].join('\n');
}

export function selectControlDescriptor(
  descriptors: readonly ListedControlDescriptor[],
  target: string,
): ListedControlDescriptor {
  if (target === 'latest') {
    const latest = descriptors.filter((descriptor) => descriptor.live).sort((left, right) => right.startedAt - left.startedAt)[0];
    if (latest === undefined) throw new Error('no live harness runs found');
    return latest;
  }
  const descriptor = descriptors.filter((entry) => entry.runId === target).sort((left, right) => right.startedAt - left.startedAt)[0];
  if (descriptor === undefined) throw new Error(`run '${target}' was not found`);
  if (!descriptor.live) throw new Error(`run '${target}' is stale; run '${harnessCommand('ps --prune')}' to remove stale descriptors`);
  return descriptor;
}

export function pruneStaleDescriptors(descriptors: readonly ListedControlDescriptor[], unlink: (path: string) => void = unlinkSync): number {
  let count = 0;
  for (const descriptor of descriptors) {
    if (descriptor.live) continue;
    try { unlink(descriptor.socketPath); } catch { /* stale sockets need not still exist */ }
    try { unlink(descriptor.path); count += 1; } catch { /* another process may already have pruned it */ }
  }
  return count;
}

export function tailLines(text: string, count = 40): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-count).join('\n');
}

export function daemonLogPath(descriptor: ControlDescriptor, logDir: string): string {
  return descriptor.logPath ?? resolve(logDir, `${descriptor.runId}.log`);
}

export function readLogTail(path: string, count = 40, read: (path: string) => string = (file) => readFileSync(file, 'utf8')): string {
  return tailLines(read(path), count);
}

export async function runPhasesSubcommand(
  command: Extract<HarnessSubcommand, { readonly name: 'phases' }>,
  descriptors: readonly ListedControlDescriptor[],
): Promise<number> {
  const script = validatePhaseScript(JSON.parse(readFileSync(command.scriptPath, 'utf8')) as unknown);
  const descriptor = selectControlDescriptor(descriptors, command.target);
  const client = await connectControl(descriptor);
  try {
    await runPhaseScript(script, client);
    return 0;
  } finally {
    await client.close();
  }
}
