import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTOR_COMMAND_TYPES } from '#protocol';
import type { PromptName } from '../core/prompts.ts';
import { createPromptLibrary, PROMPT_NAMES, PromptVarError } from './index.ts';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type PromptNamesMatchContract = Assert<Equal<(typeof PROMPT_NAMES)[number], PromptName>>;
const promptNamesMatchContract: PromptNamesMatchContract = true;

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PROMPT_DIR = resolve(REPO_ROOT, 'prompts');
const SYSTEM_PLACEHOLDERS: Readonly<Record<PromptName, readonly string[]>> = {
  'world-basics': [],
  commands: [],
  combat: [],
  skilling: [],
  economy: [],
  'dialogue-and-quests': [],
  navigation: [],
  'reflex-authoring': [],
  'social-games': [],
  'agent-system': ['identity', 'world', 'goal', 'persona', 'voice', 'team', 'reflexes', 'memories', 'tools'],
  'coordinator-system': ['team', 'mission', 'agents', 'director_notes'],
  'director-system': ['run', 'world', 'agents', 'teams', 'mcp_tools'],
  'admin-system': ['run', 'world', 'agents', 'tools']
};

function placeholders(text: string): string[] {
  return [...text.matchAll(/{{([^{}]+)}}/g)].map((match) => match[1] as string);
}

describe('grounding prompt library', () => {
  test('matches the closed contract and eagerly loads every non-empty prompt', () => {
    expect(promptNamesMatchContract).toBe(true);
    expect(PROMPT_NAMES).toHaveLength(13);
    const library = createPromptLibrary();
    expect(library.list()).toEqual(PROMPT_NAMES);
    for (const name of PROMPT_NAMES) expect(library.get(name).length).toBeGreaterThan(0);
  });

  test('keeps every prompt within its word limit', () => {
    const library = createPromptLibrary();
    for (const name of PROMPT_NAMES) {
      const limit = name === 'commands' ? 1600 : name === 'reflex-authoring' ? 1300 : 900;
      expect(library.get(name).match(/\S+/g)?.length ?? 0, name).toBeLessThanOrEqual(limit);
    }
  });

  test('ends every prompt with source paths that exist', () => {
    const library = createPromptLibrary();
    for (const name of PROMPT_NAMES) {
      const match = library.get(name).match(/<!-- sources: ([^>]+) -->$/);
      expect(match, name).not.toBeNull();
      const sources = (match?.[1] ?? '').split(',').map((source) => source.trim());
      expect(sources.length, name).toBeGreaterThan(0);
      for (const source of sources) expect(existsSync(resolve(REPO_ROOT, source)), `${name}: ${source}`).toBe(true);
    }
  });

  test('renders supplied variables and reports every missing variable', () => {
    const library = createPromptLibrary();
    const vars = Object.fromEntries(SYSTEM_PLACEHOLDERS['agent-system'].map((key) => [key, `<${key}>`]));
    const rendered = library.render('agent-system', vars);
    expect(rendered).toContain('<identity>');
    expect(rendered).not.toContain('{{');

    try {
      library.render('agent-system', { identity: 'one value' });
      throw new Error('expected render to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptVarError);
      expect((error as PromptVarError).missingKeys).toEqual([
        'world', 'goal', 'persona', 'voice', 'team', 'reflexes', 'memories', 'tools'
      ]);
    }
  });

  test('uses exactly the contracted placeholders in system frames and nowhere else', () => {
    for (const name of PROMPT_NAMES) {
      const text = readFileSync(resolve(PROMPT_DIR, `${name}.md`), 'utf8');
      expect(placeholders(text), name).toEqual([...SYSTEM_PLACEHOLDERS[name]]);
    }
  });

  test('documents every actor command and no admin command', () => {
    const commands = createPromptLibrary().get('commands');
    for (const type of ACTOR_COMMAND_TYPES) {
      expect(commands, type).toContain(`| \`${type}\` |`);
    }
    for (const type of ['step', 'spawn', 'despawn', 'stop', 'end']) {
      expect(commands, type).not.toContain(`| \`${type}\` |`);
    }
  });

  test('grounds wave-1 affordances and anti-scam flow', () => {
    const library = createPromptLibrary();
    expect(library.get('world-basics')).toContain('`options` list');
    expect(library.get('world-basics')).toContain('`no_handler`');
    expect(library.get('economy')).toContain('`trade-accept` a second time');
    expect(library.get('skilling')).toContain('| Fletching |');
    expect(library.get('reflex-authoring')).toContain('| `trade` |');
    expect(library.get('reflex-authoring')).toContain('| `herblore-loop` |');
    expect(library.get('social-games')).toContain('`poll-closed`');
  });
});
