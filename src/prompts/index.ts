import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PromptLibrary, PromptName } from '../core/prompts.ts';

export const PROMPT_NAMES = [
  'world-basics',
  'commands',
  'agent-system',
  'coordinator-system',
  'director-system',
  'admin-system'
] as const satisfies readonly PromptName[];

export class PromptMissingError extends Error {
  constructor(readonly promptName: PromptName, readonly path: string) {
    super(`Missing prompt file: ${promptName} (${path})`);
    this.name = 'PromptMissingError';
  }
}

export class PromptVarError extends Error {
  constructor(readonly promptName: PromptName, readonly missingKeys: readonly string[]) {
    super(`Missing variable(s) for prompt ${promptName}: ${missingKeys.join(', ')}`);
    this.name = 'PromptVarError';
  }
}

const PLACEHOLDER = /{{([^{}]+)}}/g;

export function createPromptLibrary(dir = resolve(import.meta.dir, '../../prompts')): PromptLibrary {
  const prompts = new Map<PromptName, string>();
  for (const name of PROMPT_NAMES) {
    const path = resolve(dir, `${name}.md`);
    if (!existsSync(path)) throw new PromptMissingError(name, path);
    prompts.set(name, readFileSync(path, 'utf8').trim());
  }
  return {
    get(name) {
      const prompt = prompts.get(name);
      if (prompt === undefined) throw new PromptMissingError(name, resolve(dir, `${name}.md`));
      return prompt;
    },
    render(name, vars) {
      const prompt = this.get(name);
      const missing = [...new Set([...prompt.matchAll(PLACEHOLDER)]
        .map((match) => match[1])
        .filter((key): key is string => key !== undefined && !Object.hasOwn(vars, key)))];
      if (missing.length > 0) throw new PromptVarError(name, missing);
      return prompt.replace(PLACEHOLDER, (_whole, key: string) => vars[key] as string);
    },
    list: () => [...PROMPT_NAMES]
  };
}
