import { describe, expect, test } from 'bun:test';
import { CHAT } from './chat.ts';
import { FakeContext, makeEvent } from '../testing.ts';

describe('chat', () => {
  test('sends a direct templated PM', async () => {
    const ctx = new FakeContext();
    const behaviour = CHAT.create({ channel: 'pm', to: 'Alice', text: 'Hello {name}, I am {agent}.' });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.intents.at(-1)).toMatchObject({
      type: 'pm', data: { to: 'Alice', text: 'Hello Alice, I am Agent.' }
    });
  });

  test('waits for a mention and replies to the speaker', async () => {
    const ctx = new FakeContext();
    const behaviour = CHAT.create({ channel: 'pm', replyToMentions: true, text: 'Hi {name}: saw "{text}"' });
    expect(await behaviour.start(ctx)).toMatchObject({ state: 'running' });
    expect(ctx.intents).toHaveLength(0);

    ctx.inject(makeEvent('chat', { entity: 2, name: 'Alice', text: 'Agent, are you there?', channel: 'public' }));
    expect(await behaviour.step(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.intents.at(-1)).toMatchObject({
      type: 'pm', data: { to: 'Alice', text: 'Hi Alice: saw "Agent, are you there?"' }
    });
  });
});
