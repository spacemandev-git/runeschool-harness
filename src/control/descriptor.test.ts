import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlDescriptor } from '../core/control.ts';
import {
  descriptorPath,
  listControlDescriptors,
  readDescriptor,
  removeDescriptor,
  socketPath,
  writeDescriptor,
} from './descriptor.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-control-descriptor-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function descriptor(logDir: string, runId: string, pid: number, startedAt: number): ControlDescriptor {
  return {
    runId,
    pid,
    socketPath: socketPath(logDir, runId),
    startedAt,
    mcpUrl: 'http://127.0.0.1:7780/mcp',
    instanceId: 'inst-test',
  };
}

describe('control descriptors', () => {
  test('round trips atomically with owner-only permissions and can be removed', async () => {
    const logDir = await temporaryDirectory();
    const path = descriptorPath(logDir, 'round-trip');
    const value = descriptor(logDir, 'round-trip', process.pid, 100);

    await writeDescriptor(path, value);

    expect(await readDescriptor(path)).toEqual(value);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await removeDescriptor(path);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test('lists newest first, reports live and stale pids, and skips malformed files', async () => {
    const logDir = await temporaryDirectory();
    await writeDescriptor(descriptorPath(logDir, 'older-live'), descriptor(logDir, 'older-live', process.pid, 100));
    await writeDescriptor(descriptorPath(logDir, 'newer-stale'), descriptor(logDir, 'newer-stale', 2_147_483_647, 200));
    await writeFile(join(logDir, 'broken.control.json'), '{not json', 'utf8');

    const listed = await listControlDescriptors(logDir);

    expect(listed.map((entry) => entry.runId)).toEqual(['newer-stale', 'older-live']);
    expect(listed.map((entry) => entry.live)).toEqual([false, true]);
    expect(listed.map((entry) => entry.path)).toEqual([
      descriptorPath(logDir, 'newer-stale'),
      descriptorPath(logDir, 'older-live'),
    ]);
  });

  test('uses the temporary directory when a Unix socket path would exceed 100 bytes', async () => {
    const logDir = join(await temporaryDirectory(), 'x'.repeat(110));
    expect(socketPath(logDir, 'run')).toBe(join(tmpdir(), 'harness-run.sock'));
  });
});
