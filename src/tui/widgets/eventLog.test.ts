import { expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createBus } from '../../bus/index.ts';
import { createEventLog, LOG_ROW_CAP } from './eventLog.ts';

test('2500 agent.delta events leave at most 2000 log rows', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const log = createEventLog(setup.renderer);
  setup.renderer.root.add(log.root);
  const bus = createBus();
  bus.on('agent.delta', (event) => {
    for (const line of event.data.delta.lines) log.append(line, 'move');
  });
  for (let index = 0; index < 2_500; index += 1) {
    bus.emit('agent.delta', { agentId: 'hero', delta: {
      fromSeq: index, toSeq: index + 1, fromTick: index, toTick: index + 1,
      xpGained: [], levelUps: [], itemsGained: [], itemsLost: [], entered: [], left: [], deaths: [],
      damageTaken: 0, damageDealt: 0, groundItemsAppeared: [], objectivesChanged: [], rejections: [],
      messages: [], lines: [`delta ${index}`], events: [],
    } });
  }
  expect(log.rowCount).toBe(LOG_ROW_CAP);
  expect(log.root.content.getChildrenCount()).toBe(LOG_ROW_CAP);
  setup.renderer.destroy();
});
