import { describe, expect, test } from 'bun:test';
import { createBus } from '../bus/index.ts';
import { createMailboxes } from './mailbox.ts';

describe('mailboxes', () => {
  test('routes in order, notifies every recipient kind, and drains', async () => {
    const bus = createBus(); let time = 10;
    const boxes = createMailboxes(bus, () => ++time);
    const notified: string[] = [];
    boxes.register('hero', (from, text) => { notified.push(`hero:${from}:${text}`); });
    boxes.register('director', (from, text) => { notified.push(`director:${from}:${text}`); });
    boxes.register('coordinator:red', (from, text) => { notified.push(`coord:${from}:${text}`); });
    boxes.send('director', 'hero', 'first');
    boxes.send('operator', 'hero', 'second');
    boxes.send('hero', 'director', 'report');
    boxes.send('hero', 'coordinator:red', 'team report');
    await Promise.resolve();
    expect(boxes.pending('hero')).toBe(2);
    expect(boxes.drain('hero').map((message) => message.text)).toEqual(['first', 'second']);
    expect(boxes.pending('hero')).toBe(0);
    expect(notified).toEqual([
      'hero:director:first', 'hero:operator:second', 'director:hero:report', 'coord:hero:team report'
    ]);
    expect(bus.history({ prefix: 'agent.message' })).toHaveLength(4);
  });
});
