import { describe, expect, test } from 'bun:test';
import type { PerceptDelta } from '../core/percept.ts';
import type { WakePolicyConfig } from '../core/agent.ts';
import { diffSnapshots } from '../perception/differ.ts';
import { eventOf, makeSnapshot } from '../perception/testing.ts';
import { salientReasons } from './salience.ts';

const config: WakePolicyConfig = {
  minIntervalMs: 0, heartbeatMs: 1_000, hpAlertFraction: 0.5, maxTurns: 0, maxToolCallsPerWake: 4
};

function delta(overrides: Partial<PerceptDelta> = {}): PerceptDelta {
  return {
    fromSeq: 0, toSeq: 1, fromTick: 0, toTick: 1,
    xpGained: [], levelUps: [], itemsGained: [], itemsLost: [], entered: [], left: [], deaths: [],
    damageTaken: 0, damageDealt: 0, groundItemsAppeared: [], objectivesChanged: [], rejections: [],
    messages: [], lines: [], events: [], ...overrides
  };
}

describe('mind salience', () => {
  test.each([
    delta({ deaths: [{ entity: 1, isSelf: true }] }),
    delta({ dialogue: { active: true, options: ['Yes'] } }),
    delta({ objectivesChanged: [{ id: 'x', description: 'win', outcome: 'win', complete: true, progress: [] }] }),
    delta({ messages: ['look out'] }),
    delta({ rejections: [{ type: 'walk', code: 'no', message: 'no', tick: 1, source: 'mind' }] }),
    delta({ entered: [{ id: 2, kind: 'player', at: { x: 0, z: 0, level: 0 }, distance: 1, lastSeenTick: 1 }] }),
    delta({ events: [{ type: 'scenario-won', tick: 1, seq: 1, data: { objective: 'x' } }] }),
    delta({ events: [{ type: 'actor-eliminated', tick: 1, seq: 1, data: { entity: 2, actorTag: 'rival', tick: 1 } }] }),
    delta({ events: [{ type: 'poll-closed', tick: 1, seq: 1, data: { poll: 'council', winner: 2, reason: 'quorum' } }] })
  ])('wakes for every specified event family', (input) => {
    expect(salientReasons(input, config)).toEqual(['salient-event']);
  });

  test('hp threshold is a falling edge', () => {
    expect(salientReasons(delta({ hp: { before: { current: 8, max: 10 }, after: { current: 5, max: 10 } } }), config))
      .toEqual(['salient-event']);
    expect(salientReasons(delta({ hp: { before: { current: 5, max: 10 }, after: { current: 4, max: 10 } } }), config))
      .toEqual([]);
  });

  test('wakes when self is frozen or struck by dragonfire, but not when another target is frozen', () => {
    const frozen = diffSnapshots(makeSnapshot(), makeSnapshot(), [eventOf('spell-effect', {
      attacker: 2, target: 1, spell: 'ice-rush', effect: 'bind', ticks: 8
    })]);
    const dragonfire = diffSnapshots(makeSnapshot(), makeSnapshot(), [eventOf('dragonfire', {
      attacker: 2, target: 1, damage: 0, mitigated: ['shield', 'antifire']
    })]);
    const other = {
      id: 2, kind: 'npc' as const, name: 'Target', at: { x: 1, z: 0, level: 0 },
      distance: 1, lastSeenTick: 1
    };
    const otherFrozen = diffSnapshots(makeSnapshot({ nearby: [other] }), makeSnapshot({ nearby: [other] }), [eventOf('spell-effect', {
      attacker: 1, target: 2, spell: 'ice-blitz', effect: 'bind', ticks: 25
    })]);

    expect(salientReasons(frozen, config)).toEqual(['salient-event']);
    expect(salientReasons(dragonfire, config)).toEqual(['salient-event']);
    expect(salientReasons(otherFrozen, config)).toEqual([]);
  });

  test('ordinary changes remain silent', () => {
    expect(salientReasons(delta({ xpGained: [{ skill: 'attack', amount: 4 }] }), config)).toEqual([]);
  });
});
