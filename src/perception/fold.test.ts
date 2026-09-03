import { describe, expect, test } from 'bun:test';
import type { DefsReader } from '../core/index.ts';
import { createBus } from '../bus/index.ts';
import { createMutableState, expireWalking, foldActionOutcome, foldEvent } from './fold.ts';
import { createWorldModel } from './worldModel.ts';
import { diedEvent, eventOf, FakeActorLink, hitEvent, makeSnapshot, movedEvent } from './testing.ts';
import { renderSnapshot } from './summarizer.ts';

describe('event folding', () => {
  test('folds combat damage and removes dead nearby entities and engagements', () => {
    const base = makeSnapshot({
      nearby: [{
        id: 2, kind: 'npc', npc: 100, name: 'Goblin',
        at: { x: 101, z: 100, level: 0 }, distance: 1,
        hp: { current: 5, max: 5 }, lastSeenTick: 10
      }]
    });
    const state = createMutableState(base);
    foldEvent(state, hitEvent(2, 1, 3, 7, 1, 11));
    expect(state.self.hp.current).toBe(7);
    expect(state.self.combat).toMatchObject({ inCombat: true, attackedBy: [2] });
    expect(state.nearby[0]?.engaging).toBe(1);

    foldEvent(state, diedEvent(2, 1, 2, 12));
    expect(state.nearby).toEqual([]);
    expect(state.self.combat.attackedBy).toEqual([]);
  });

  test('infers walking, settles on arrival, and expires silent walks after five ticks', () => {
    const state = createMutableState(makeSnapshot());
    foldActionOutcome(state, {
      intent: {
        type: 'walk', data: { dest: { x: 102, z: 100, level: 0 } }, source: { kind: 'mind' }
      },
      ok: true,
      tick: 10,
      sentAt: 0
    });
    expect(state.self.activity).toMatchObject({ kind: 'walking', dest: { x: 102, z: 100, level: 0 } });
    foldEvent(state, movedEvent(1, { x: 100, z: 100, level: 0 }, { x: 102, z: 100, level: 0 }, 1, 11));
    expect(state.self.activity).toEqual({ kind: 'idle' });

    foldActionOutcome(state, {
      intent: {
        type: 'run', data: { dest: { x: 110, z: 100, level: 0 } }, source: { kind: 'mind' }
      },
      ok: true,
      tick: 20,
      sentAt: 0
    });
    expireWalking(state, 24);
    expect(state.self.activity.kind).toBe('walking');
    expireWalking(state, 25);
    expect(state.self.activity).toEqual({ kind: 'idle' });
  });

  test('folds dialogue choices and marks incomplete inventory events dirty', () => {
    const state = createMutableState(makeSnapshot());
    foldEvent(state, eventOf('dialogue-started', { entity: 1, dialogue: 'guide' }));
    foldEvent(state, eventOf('dialogue-node', {
      entity: 1,
      dialogue: 'guide',
      nodeId: 'pick',
      kind: 'choice',
      prompt: 'Where?',
      options: ['North', 'South']
    }, { seq: 2, tick: 11 }));
    expect(state.dialogue).toEqual({ active: true, text: 'Where?', options: ['North', 'South'] });
    expect(state.self.activity.kind).toBe('dialogue');

    foldEvent(state, eventOf('item-added', { entity: 1, item: 526, amount: 1, overflow: 0 }, { seq: 3 }));
    expect(state.inventoryDirty).toBe(true);
  });

  test('folds magic configuration, bind, drains, and unbound into the self view', () => {
    const state = createMutableState(makeSnapshot());
    foldActionOutcome(state, {
      intent: {
        type: 'set-style',
        data: { style: 'magic', attackStyle: 'defensive-cast', spell: 'wind-strike' },
        source: { kind: 'mind' }
      },
      ok: true,
      tick: 10,
      sentAt: 0
    });
    expect(state.self.combat.style).toEqual({
      style: 'magic', attackStyle: 'defensive-cast', spell: 'wind-strike'
    });

    foldEvent(state, eventOf('spell-effect', {
      attacker: 2, target: 1, spell: 'bind', effect: 'bind', ticks: 9
    }, { seq: 1, tick: 11 }));
    foldEvent(state, eventOf('spell-effect', {
      attacker: 2, target: 1, spell: 'confuse', effect: 'drain', skill: 'attack', amount: 3
    }, { seq: 2, tick: 12 }));
    expect(state.self.combat.bound).toBe(true);
    expect(state.self.combat.drains).toEqual({ attack: 3, strength: 0, defence: 0, magic: 0 });
    expect(renderSnapshot(makeSnapshot({ self: state.self }))).toContain(
      'autocast wind-strike; BOUND; drains attack -3'
    );

    foldEvent(state, eventOf('unbound', { entity: 1 }, { seq: 3, tick: 20 }));
    expect(state.self.combat.bound).toBe(false);

    foldActionOutcome(state, {
      intent: {
        type: 'set-style', data: { style: 'melee', attackStyle: 'accurate' }, source: { kind: 'mind' }
      },
      ok: true,
      tick: 21,
      sentAt: 0
    });
    expect(state.self.combat.style).toEqual({ style: 'melee', attackStyle: 'accurate' });

    foldActionOutcome(state, {
      intent: {
        type: 'cast', data: { target: 2, spell: 'fire-bolt' }, source: { kind: 'mind' }
      },
      ok: true,
      tick: 22,
      sentAt: 0
    });
    expect(state.self.combat.style).toEqual({ style: 'magic', attackStyle: 'cast', spell: 'fire-bolt' });
    expect(state.self.activity).toEqual({ kind: 'fighting', target: 2, since: 22 });

    state.self = { ...state.self, activity: { kind: 'idle' } };
    foldEvent(state, eventOf('spell-cast', {
      entity: 1, spell: 'home-teleport', xp: 0
    }, { seq: 4, tick: 23 }));
    expect(state.self.activity).toEqual({ kind: 'idle' });
  });

  test('resync radius-filters entities and schedules the one-pulse targeted item refresh', async () => {
    const link = new FakeActorLink();
    link.set('', { tick: 20 });
    link.set('/entities', { entities: [
      { id: 1, kind: 'player', at: { x: 100, z: 100, level: 0 }, hp: { current: 10, max: 10 } },
      { id: 2, kind: 'npc', npc: 100, at: { x: 103, z: 100, level: 0 }, hp: { current: 5, max: 5 } },
      { id: 3, kind: 'npc', npc: 100, at: { x: 120, z: 100, level: 0 }, hp: { current: 5, max: 5 } }
    ] });
    link.set('/ground-items', { items: [] });
    link.set('/nodes', { nodes: [] });
    link.set('/stations', { stations: [] });
    link.set('/heat-sources', { sources: [] });
    link.set('/entities/1/inventory', { slots: [{ item: 526, amount: 1 }, null] });
    link.set('/entities/1/equipment', { slots: [] });
    link.set('/entities/1/skills', { skills: {} });
    link.set('/entities/1/prayer', { points: 1, maxPoints: 1, active: [] });
    link.set('/objectives?actor=hero', { objectives: [], won: false, lost: false });
    const defs: DefsReader = {
      async names() { return { items: { 526: 'Bones' }, npcs: { 100: 'Goblin' } }; },
      async region() { return {}; }
    };
    const model = createWorldModel({
      agentId: 'hero', tag: 'hero', entity: 1, link, defs, bus: createBus(),
      radius: 5, resyncIntervalMs: 0
    });
    await model.start();
    expect(model.snapshot().nearby.map((entity) => entity.id)).toEqual([2]);
    link.gets.length = 0;
    link.emit(eventOf('item-added', { entity: 1, item: 995, amount: 1, overflow: 0 }, { seq: 1, tick: 21 }));
    await Bun.sleep(650);
    expect(link.gets).toEqual(['/entities/1/inventory', '/entities/1/equipment']);
    model.stop();
  });
});
