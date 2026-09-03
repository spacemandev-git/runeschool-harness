import { describe, expect, test } from 'bun:test';
import { QUEST_STEP } from './questStep.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('quest-step', () => {
  test('talks to an NPC, follows configured choices, and ends with the dialogue', async () => {
    const ctx = new FakeContext();
    const behaviour = QUEST_STEP.create({ npc: 7, choices: [1] });
    await behaviour.start(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'talk-to', data: { npc: 7 } });

    ctx.inject(makeEvent('dialogue-node', {
      entity: 1, dialogue: 'cook-start', nodeId: 'hello', kind: 'npc', speakerTag: 'cook', text: 'Can you help?'
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'dialogue-advance', data: {} });

    ctx.clearEvents();
    ctx.inject(makeEvent('dialogue-node', {
      entity: 1, dialogue: 'cook-start', nodeId: 'choice', kind: 'choice', options: ['No', 'Yes']
    }));
    await behaviour.step(ctx);
    expect(ctx.intents.at(-1)).toMatchObject({ type: 'dialogue-advance', data: { choice: 1 } });

    ctx.clearEvents();
    ctx.inject(makeEvent('dialogue-ended', { entity: 1, dialogue: 'cook-start' }));
    expect(await behaviour.step(ctx)).toEqual({ state: 'done', summary: 'quest dialogue cook-start ended' });
  });
});
