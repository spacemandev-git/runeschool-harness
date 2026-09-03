import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PromptLibrary, PromptName } from '../core/prompts.ts';

export const PROMPT_NAMES = [
  'world-basics',
  'commands',
  'combat',
  'skilling',
  'economy',
  'dialogue-and-quests',
  'navigation',
  'reflex-authoring',
  'social-games',
  'agent-system',
  'coordinator-system',
  'director-system',
  'admin-system'
] as const satisfies readonly PromptName[];

interface MissingPrompt {
  readonly name: PromptName;
  readonly path: string;
}

export class PromptMissingError extends Error {
  readonly promptName: PromptName;
  readonly path: string;
  readonly missing: readonly MissingPrompt[];

  constructor(name: PromptName, path: string, missing: readonly MissingPrompt[] = [{ name, path }]) {
    super(`Missing prompt file(s): ${missing.map((entry) => `${entry.name} (${entry.path})`).join(', ')}`);
    this.name = 'PromptMissingError';
    this.promptName = name;
    this.path = path;
    this.missing = missing;
  }
}

export class PromptVarError extends Error {
  readonly promptName: PromptName;
  readonly missingKeys: readonly string[];

  constructor(name: PromptName, missingKeys: readonly string[]) {
    super(`Missing variable(s) for prompt ${name}: ${missingKeys.join(', ')}`);
    this.name = 'PromptVarError';
    this.promptName = name;
    this.missingKeys = missingKeys;
  }
}

const PLACEHOLDER = /{{([^{}]+)}}/g;

export function createPromptLibrary(
  dir = resolve(import.meta.dir, '../../prompts')
): PromptLibrary {
  const paths = PROMPT_NAMES.map((name) => ({ name, path: resolve(dir, `${name}.md`) }));
  const missing = paths.filter(({ path }) => !existsSync(path));
  const firstMissing = missing[0];
  if (firstMissing !== undefined) {
    throw new PromptMissingError(firstMissing.name, firstMissing.path, missing);
  }

  const prompts = new Map<PromptName, string>();
  for (const entry of paths) prompts.set(entry.name, readFileSync(entry.path, 'utf8').trim());

  return {
    get(name) {
      return prompts.get(name) as string;
    },
    render(name, vars) {
      const prompt = prompts.get(name) as string;
      const missingKeys = [...new Set(
        [...prompt.matchAll(PLACEHOLDER)]
          .map((match) => match[1])
          .filter((key): key is string => key !== undefined && !Object.hasOwn(vars, key))
      )];
      if (missingKeys.length > 0) throw new PromptVarError(name, missingKeys);
      return prompt.replace(PLACEHOLDER, (_placeholder, key: string) => vars[key] as string);
    },
    list() {
      return PROMPT_NAMES;
    }
  };
}
