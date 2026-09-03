import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelSelection } from '../core/runtime.ts';

interface StoredSelections {
  readonly version: 1;
  readonly selections: readonly ModelSelection[];
}

export interface ModelSelectionStore {
  readonly path: string;
  load(): Promise<readonly ModelSelection[]>;
  save(selection: ModelSelection): Promise<void>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSelection(value: unknown): ModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('model selection must be an object');
  }
  const entry = value as Record<string, unknown>;
  if (!nonEmptyString(entry.model)) throw new Error('model selection must include a model');
  const model = entry.model.trim();
  if (entry.role === 'director' || entry.role === 'agent-default') return { role: entry.role, model };
  if (entry.role === 'coordinator' && nonEmptyString(entry.team)) {
    return { role: 'coordinator', team: entry.team, model };
  }
  if (entry.role === 'agent' && nonEmptyString(entry.agent)) {
    return { role: 'agent', agent: entry.agent, model };
  }
  throw new Error('model selection has an invalid role or target');
}

function parseStored(value: unknown): readonly ModelSelection[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('model selection file must contain an object');
  }
  const stored = value as Record<string, unknown>;
  if (stored.version !== 1 || !Array.isArray(stored.selections)) {
    throw new Error('model selection file has an unsupported format');
  }
  return stored.selections.map(parseSelection);
}

function selectionKey(selection: ModelSelection): string {
  if (selection.role === 'coordinator') return `coordinator:${selection.team}`;
  if (selection.role === 'agent') return `agent:${selection.agent}`;
  return selection.role;
}

function normalized(selection: ModelSelection): ModelSelection {
  return parseSelection(selection);
}

export function defaultModelSelectionPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir()
): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const configHome = configured === undefined || configured.length === 0
    ? join(userHome, '.config')
    : configured;
  return join(configHome, 'runeschool-harness', 'model-selections.json');
}

export function createModelSelectionStore(
  path = defaultModelSelectionPath()
): ModelSelectionStore {
  const load = async (): Promise<readonly ModelSelection[]> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      return parseStored(JSON.parse(text) as unknown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read persisted model selections at ${path}: ${detail}`, { cause: error });
    }
  };

  return {
    path,
    load,
    async save(selection): Promise<void> {
      const byTarget = new Map((await load()).map((entry) => [selectionKey(entry), entry]));
      const next = normalized(selection);
      byTarget.set(selectionKey(next), next);
      const stored: StoredSelections = {
        version: 1,
        selections: [...byTarget.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, entry]) => entry),
      };
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        });
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}
