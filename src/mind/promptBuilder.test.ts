import { describe, expect, test } from 'bun:test';
import type { MindDeps } from '../core/agent.ts';
import { createPromptLibrary } from '../prompts/index.ts';
import { buildSystemPrompt } from './promptBuilder.ts';

function deps(spec: MindDeps['spec']): MindDeps {
  return {
    agentId: spec.id,
    spec,
    view: { entity: 42 },
    prompts: createPromptLibrary(),
    worldContext: {},
    reflexes: { state: () => ({ rules: [], queue: [] }) }
  } as unknown as MindDeps;
}

describe('buildSystemPrompt', () => {
  test('renders a configured voice without changing persona rendering', () => {
    const prompt = buildSystemPrompt(deps({
      id: 'rook',
      persona: 'A fearless arena herald.',
      voice: 'Boom out theatrical challenges.'
    }), {});

    expect(prompt).toContain('## Persona\n\nA fearless arena herald.');
    expect(prompt).toContain('## Voice\n\nBoom out theatrical challenges.');
    expect(prompt).toContain('Deliver every public message in this voice.');
  });

  test('uses the neutral voice fallback when voice is absent', () => {
    const prompt = buildSystemPrompt(deps({ id: 'rook', persona: 'A fearless arena herald.' }), {});

    expect(prompt).toContain('## Persona\n\nA fearless arena herald.');
    expect(prompt).toContain('## Voice\n\nSpeak naturally, in character.');
  });
});
