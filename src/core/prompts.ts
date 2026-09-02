/**
 * Grounding prompts loaded by `prompts/index.ts`.
 * Names are closed so the mind/director/coordinator can reference them without string guessing.
 */
export type PromptName =
  | 'world-basics'
  | 'commands'
  | 'agent-system'
  | 'coordinator-system'
  | 'director-system'
  | 'admin-system';

export interface PromptLibrary {
  get(name: PromptName): string;
  /** Substitute `{{key}}` placeholders; missing keys throw. */
  render(name: PromptName, vars: Readonly<Record<string, string>>): string;
  list(): readonly PromptName[];
}
