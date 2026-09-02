import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ControlDescriptor } from '../core/control.ts';

const CONTROL_SUFFIX = '.control.json';
const SOCKET_SUFFIX = '.sock';
const MAX_SOCKET_PATH_BYTES = 100;

export type ListedControlDescriptor = ControlDescriptor & {
  readonly live: boolean;
  readonly path: string;
};

export function descriptorPath(logDir: string, runId: string): string {
  return join(logDir, `${runId}${CONTROL_SUFFIX}`);
}

export function socketPath(logDir: string, runId: string): string {
  const candidate = resolve(logDir, `${runId}${SOCKET_SUFFIX}`);
  if (Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES) return candidate;
  return join(tmpdir(), `harness-${runId}${SOCKET_SUFFIX}`);
}

function controlDescriptor(value: unknown): ControlDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('control descriptor must be an object');
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.runId !== 'string'
    || !Number.isInteger(entry.pid)
    || (entry.pid as number) <= 0
    || typeof entry.socketPath !== 'string'
    || !isAbsolute(entry.socketPath)
    || typeof entry.startedAt !== 'number'
    || !Number.isFinite(entry.startedAt)
    || typeof entry.mcpUrl !== 'string'
    || (entry.logPath !== undefined && typeof entry.logPath !== 'string')
    || (entry.instanceId !== undefined && typeof entry.instanceId !== 'string')) {
    throw new Error('invalid control descriptor');
  }
  return entry as unknown as ControlDescriptor;
}

/** Atomically write a descriptor at `path`, creating its parent directory when needed. */
export async function writeDescriptor(path: string, descriptor: ControlDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readDescriptor(path: string): Promise<ControlDescriptor> {
  return controlDescriptor(JSON.parse(await readFile(path, 'utf8')));
}

export async function removeDescriptor(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return false;
  }
}

export async function listControlDescriptors(logDir: string): Promise<readonly ListedControlDescriptor[]> {
  let names: string[];
  try {
    names = (await readdir(logDir)).filter((name) => name.endsWith(CONTROL_SUFFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const descriptors = await Promise.all(names.map(async (name): Promise<ListedControlDescriptor | undefined> => {
    const path = join(logDir, name);
    try {
      const descriptor = await readDescriptor(path);
      return { ...descriptor, live: processIsLive(descriptor.pid), path };
    } catch {
      return undefined;
    }
  }));
  return descriptors
    .filter((descriptor): descriptor is ListedControlDescriptor => descriptor !== undefined)
    .sort((left, right) => right.startedAt - left.startedAt);
}
