import { describe, expect, test } from 'bun:test';
import type { PerceptDelta, RejectionView } from '../core/index.ts';
import { diffSnapshots } from './differ.ts';
import { renderDeltaLines, renderSnapshot } from './summarizer.ts';
import { diedEvent, eventOf, hitEvent, makeSnapshot } from './testing.ts';

const nameOf = (kind: 'item' | 'npc' | 'loc', id: number): string | undefined =>
  kind === 'item' && id === 526 ? 'bones' : undefined;

describe('perception rendering', () => {
  test('renders delta lines in priority order with compass directions', () => {
    const base = makeSnapshot();
    const goblin = {
      id: 2, kind: 'npc' as const, name: 'Goblin', npc: 100,
      at: { x: 101, z: 101, level: 0 }, distance: 1,
      hp: { current: 5, max: 5 }, lastSeenTick: 10
    };
    const before = makeSnapshot({ nearby: [goblin], lastEventSeq: 1 });
    const after = makeSnapshot({
      self: {
        ...base.self, hp: { current: 0, max: 10 }, dead: true,
        at: { x: 102, z: 100, level: 0 }
      },
      inventory: [{ slot: 0, item: 526, name: 'bones', amount: 3 }],
      inventoryFree: 27,
      nearby: [{ ...goblin, id: 3, name: 'Scout', at: { x: 104, z: 102, level: 0 }, distance: 2 }],
      groundItems: [{ id: 88, item: 526, name: 'bones', amount: 1, at: { x: 100, z: 100, level: 0 }, distance: 2 }],
      dialogue: { active: true, speaker: 'Guide', text: 'Choose', options: ['A', 'B'] },
      objectives: [{ id: 'goal', description: 'Escape', outcome: 'win', complete: true, progress: [] }],
      lastEventSeq: 8
    });
    const rejection: RejectionView = {
      type: 'walk', code: 'too_far', message: 'Move closer', tick: 11, source: 'mind'
    };
    const delta = diffSnapshots(before, after, [
      hitEvent(2, 1, 10, 0, 2, 11),
      diedEvent(1, 2, 3, 11),
      eventOf('level-up', { entity: 1, skill: 'attack', level: 2 }, { seq: 4 }),
      eventOf('xp-gained', { entity: 1, skill: 'attack', amount: 12, totalXp: 12 }, { seq: 5 }),
      eventOf('scenario-message', { text: 'Run!' }, { seq: 6 })
    ], [rejection]);
    const lines = renderDeltaLines(delta, nameOf);
    expect(lines[0]).toStartWith('YOU DIED');
    expect(lines[1]).toBe('HP 10→0/10 (-10 from goblin#2)');
    expect(lines[2]).toBe('REJECTED walk: too_far — Move closer');
    expect(lines.findIndex((line) => line.startsWith('Dialogue:')))
      .toBeLessThan(lines.findIndex((line) => line.startsWith('Objective complete:')));
    expect(lines).toContain('scout#3 appeared 2 tiles NE');
    expect(lines).toContain('bones on ground 2W (id 88)');
  });

  test('caps deltas at 40 lines and is deterministic', () => {
    const base = diffSnapshots(makeSnapshot(), makeSnapshot(), []);
    const crowded: PerceptDelta = {
      ...base,
      messages: Array.from({ length: 50 }, (_, index) => `message ${index}`)
    };
    const first = renderDeltaLines(crowded, nameOf);
    expect(first).toHaveLength(40);
    expect(first.at(-1)).toBe('… and 11 more');
    expect(renderDeltaLines(crowded, nameOf)).toEqual(first);
  });

  test('renders compact deterministic snapshots without raw JSON', () => {
    const base = makeSnapshot();
    const snapshot = makeSnapshot({
      self: { ...base.self, prayer: { points: 3, maxPoints: 5, active: ['thick-skin'] } },
      inventory: [{ slot: 0, item: 526, name: 'bones', amount: 3 }],
      inventoryFree: 27,
      equipment: { weapon: { item: 1277, name: 'Bronze sword', amount: 1 } },
      skills: { attack: { level: 2, xp: 83 }, defence: { level: 1, xp: 0 } },
      nearby: [{
        id: 2, kind: 'npc', name: 'Goblin', npc: 100,
        at: { x: 103, z: 102, level: 0 }, distance: 3,
        options: ['Talk-to', 'Attack', 'Pickpocket'], hp: { current: 5, max: 5 }, lastSeenTick: 10
      }],
      trade: { partner: 3, stage: 'confirm', ownOffer: [{ item: 995, amount: 10 }], partnerOffer: [] }
    });
    const first = renderSnapshot(snapshot);
    expect(first).toContain('npc goblin#2 [Talk-to, Attack, Pickpocket] hp 5/5 3 NE (103,102,0)');
    expect(first).toContain('Trade with entity#3: confirm; you offer item#995×10; they offer nothing');
    expect(first).not.toContain('{"');
    expect(first.split('\n').length).toBeLessThanOrEqual(60);
    expect(renderSnapshot(snapshot)).toBe(first);
  });

  test('renders recent in-world chat', () => {
    const text = renderSnapshot(makeSnapshot({
      chat: [{
        entity: 2,
        name: 'Alice',
        text: 'hello there',
        channel: 'public',
        tick: 10
      }]
    }));
    expect(text).toContain('Recent chat:');
    expect(text).toContain('[public] Alice: hello there');
    const delta = diffSnapshots(makeSnapshot(), makeSnapshot(), [
      eventOf('chat', {
        entity: 2, name: 'Alice', text: 'hello there', channel: 'public'
      })
    ]);
    expect(renderDeltaLines(delta, nameOf)).toContain('Public chat — Alice: "hello there"');
  });

  test('renders polls, elimination, notices, team outcomes, and scenario teleport events', () => {
    const events = [
      eventOf('poll-opened', { poll: 'council', eligible: [1, 2, 3], closesAtTick: 30 }, { seq: 1 }),
      eventOf('vote-cast', { entity: 1, poll: 'council', target: 2 }, { seq: 2 }),
      eventOf('vote-cast', { entity: 3, poll: 'council', target: null }, { seq: 3 }),
      eventOf('vote-tally', { poll: 'council', counts: [{ target: 2, votes: 1 }], abstentions: 1, eligible: 3 }, { seq: 4 }),
      eventOf('poll-closed', { poll: 'council', winner: 2, reason: 'quorum' }, { seq: 5 }),
      eventOf('actor-eliminated', { entity: 2, actorTag: 'suspect', tick: 10, killer: 1 }, { seq: 6 }),
      eventOf('scenario-message', { text: 'The council adjourns.' }, { seq: 7 }),
      eventOf('scenario-notice', { entity: 1, text: 'Your role remains secret.' }, { seq: 8 }),
      eventOf('team-won', { team: 'red', objective: 'red-wins' }, { seq: 9 }),
      eventOf('team-lost', { team: 'blue', objective: 'red-wins' }, { seq: 10 }),
      eventOf('scenario-teleported', { entity: 1, to: { x: 3200, z: 3201, level: 0 } }, { seq: 11 })
    ];
    const lines = renderDeltaLines(diffSnapshots(
      makeSnapshot(), makeSnapshot({ lastEventSeq: 11 }), events
    ), nameOf);
    expect(lines).toEqual([
      'Message: The council adjourns.',
      'Poll council opened: eligible entity#1, entity#2, entity#3; closes tick 30',
      'Vote council: entity#1 voted for entity#2',
      'Vote council: entity#3 abstained',
      'Poll council tally: entity#2 1; 1 abstained; 3 eligible',
      'Poll council closed (quorum): winner entity#2',
      'Actor suspect eliminated (entity#2) by entity#1',
      'Notice: Your role remains secret.',
      'Team red won (objective red-wins)',
      'Team blue lost (objective red-wins)',
      'Scenario teleported entity#1 to (3200,3201,0)'
    ]);
  });

  test('unknown events still fall through without a rendered line', () => {
    const base = diffSnapshots(makeSnapshot(), makeSnapshot(), []);
    const delta: PerceptDelta = {
      ...base,
      events: [{ type: 'future-event', tick: 10, seq: 1, data: { value: true } } as never]
    };
    expect(renderDeltaLines(delta, nameOf)).toEqual([]);
  });

  test('renders dragonfire damage and its mitigation stack', () => {
    const before = makeSnapshot({
      nearby: [{
        id: 2, kind: 'npc', name: 'Green dragon', npc: 941,
        at: { x: 101, z: 100, level: 0 }, distance: 1,
        hp: { current: 100, max: 100 }, lastSeenTick: 10
      }],
      lastEventSeq: 0
    });
    const event = eventOf('dragonfire', {
      attacker: 2,
      target: 1,
      damage: 0,
      mitigated: ['shield', 'antifire']
    }, { seq: 1 });
    const lines = renderDeltaLines(
      diffSnapshots(before, makeSnapshot({ lastEventSeq: 1 }), [event]),
      nameOf
    );
    expect(lines).toContain('green dragon#2 breathes fire on entity#1 for 0 (shield+antifire)');
  });

  test('renders projectile combat, bolt procs, blocked shots, and self freezes', () => {
    const before = makeSnapshot({
      nearby: [
        {
          id: 2, kind: 'npc', name: 'Archer', npc: 27,
          at: { x: 104, z: 100, level: 0 }, distance: 4,
          hp: { current: 30, max: 30 }, lastSeenTick: 10
        },
        {
          id: 3, kind: 'npc', name: 'Wizard', npc: 13,
          at: { x: 100, z: 104, level: 0 }, distance: 4,
          hp: { current: 20, max: 20 }, lastSeenTick: 10
        }
      ],
      lastEventSeq: 0
    });
    const events = [
      eventOf('swing-blocked', { attacker: 1, target: 2, reason: 'line-of-sight' }, { seq: 1 }),
      eventOf('bolt-proc', { attacker: 1, target: 2, bolt: 9243, effect: 'diamond' }, { seq: 2 }),
      eventOf('hit', {
        attacker: 2, target: 1, damage: 4, hpAfter: 6,
        style: 'range', attackStyle: 'range-accurate', delay: 3
      }, { seq: 3 }),
      eventOf('hit', {
        attacker: 3, target: 1, damage: 5, hpAfter: 1,
        style: 'magic', attackStyle: 'cast', delay: 2
      }, { seq: 4 }),
      eventOf('spell-effect', {
        attacker: 3, target: 1, spell: 'ice-blitz', effect: 'bind', ticks: 25
      }, { seq: 5 })
    ];
    const lines = renderDeltaLines(
      diffSnapshots(before, makeSnapshot({ lastEventSeq: 5 }), events),
      nameOf
    );
    expect(lines).toContain('Line of sight blocks entity#1 → archer#2');
    expect(lines).toContain('Bolt proc diamond (item#9243): entity#1 → archer#2');
    expect(lines).toContain('archer#2 hits entity#1 for 4 (range)');
    expect(lines).toContain('wizard#3 hits entity#1 for 5 (magic)');
    expect(lines).toContain('You are frozen (25 ticks)');
  });

  test('renders one compact line for every wave-1 event', () => {
    const before = makeSnapshot({ lastEventSeq: 0 });
    const events = [
      eventOf('interacted', { entity: 1, target: { kind: 'npc', id: 12 }, option: 'Pickpocket', handler: 'core' }, { seq: 1 }),
      eventOf('item-used', { entity: 1, item: 946, target: { kind: 'player', id: 1 }, handler: 'fletching' }, { seq: 2 }),
      eventOf('trade-requested', { entity: 1, target: 2 }, { seq: 3 }),
      eventOf('trade-opened', { a: 1, b: 2 }, { seq: 4 }),
      eventOf('trade-updated', { entity: 1, partner: 2, offer: [{ item: 995, amount: 10 }] }, { seq: 5 }),
      eventOf('trade-stage', { a: 1, b: 2, stage: 'confirm' }, { seq: 6 }),
      eventOf('trade-completed', { a: 1, b: 2, aGave: [{ item: 995, amount: 10 }], bGave: [] }, { seq: 7 }),
      eventOf('trade-declined', { entity: 1, partner: 2, reason: 'declined' }, { seq: 8 }),
      eventOf('fletched', { entity: 1, product: 52, amount: 15, xp: 5 }, { seq: 9 }),
      eventOf('fletching-stopped', { entity: 1, reason: 'completed' }, { seq: 10 }),
      eventOf('herb-cleaned', { entity: 1, herb: 199, product: 249, xp: 2.5 }, { seq: 11 }),
      eventOf('potion-made', { entity: 1, product: 121, xp: 25 }, { seq: 12 }),
      eventOf('herblore-stopped', { entity: 1, reason: 'completed' }, { seq: 13 })
    ];
    const delta = diffSnapshots(before, makeSnapshot({ lastEventSeq: 13 }), events);
    const lines = renderDeltaLines(delta, nameOf);
    expect(lines.filter((line) => /^(Interacted|Used|Trade|Fletched|Fletching|Cleaned|Made|Herblore)/.test(line))).toHaveLength(events.length);
    expect(lines).toContain('Fletched 15 item#52 (+5 xp)');
    expect(lines).toContain('Herblore stopped: completed');
  });

  test('renders status and one compact line for every wave-2 event', () => {
    const before = makeSnapshot({ lastEventSeq: 0 });
    const events = [
      eventOf('poisoned', { entity: 1, severity: 12, source: 2 }, { seq: 1 }),
      eventOf('poison-damage', { entity: 1, damage: 3, severity: 12 }, { seq: 2 }),
      eventOf('poison-cured', { entity: 1, reason: 'cured' }, { seq: 3 }),
      eventOf('stat-boosted', { entity: 1, skill: 'strength', delta: 5, current: 15, base: 10 }, { seq: 4 }),
      eventOf('stat-restored', { entity: 1, skill: 'strength', current: 14, base: 10 }, { seq: 5 }),
      eventOf('drank', { entity: 1, item: 2434, product: 139 }, { seq: 6 }),
      eventOf('special-energy', { entity: 1, energy: 50 }, { seq: 7 }),
      eventOf('special-toggled', { entity: 1, enabled: true }, { seq: 8 }),
      eventOf('special-attack', { attacker: 1, target: 2, weapon: 4151, special: 'energy-drain', energyCost: 50 }, { seq: 9 }),
      eventOf('run-energy', { entity: 1, energy: 63, weight: 12 }, { seq: 10 }),
      eventOf('run-toggled', { entity: 1, enabled: true }, { seq: 11 }),
      eventOf('skulled', { entity: 1, until: 2011 }, { seq: 12 }),
      eventOf('skull-expired', { entity: 1 }, { seq: 13 }),
      eventOf('zone-entered', { entity: 1, zone: 'wild', tags: ['wilderness', 'multi'] }, { seq: 14 }),
      eventOf('zone-left', { entity: 1, zone: 'wild' }, { seq: 15 }),
      eventOf('items-lost-on-death', { entity: 1, kept: [{ item: 526, amount: 1 }], dropped: [{ item: 995, amount: 10 }], killer: 2 }, { seq: 16 }),
      eventOf('grave-spawned', { entity: 20, owner: 1, at: { x: 100, z: 100, level: 0 }, expiresAt: 220 }, { seq: 17 }),
      eventOf('grave-expired', { entity: 20, owner: 1 }, { seq: 18 }),
      eventOf('runes-crafted', { entity: 1, rune: 556, amount: 10, xp: 50 }, { seq: 19 }),
      eventOf('ruin-entered', { entity: 1, altar: 'air' }, { seq: 20 }),
      eventOf('pouch-filled', { entity: 1, pouch: 5509, essence: 3 }, { seq: 21 }),
      eventOf('pouch-emptied', { entity: 1, pouch: 5509, essence: 3 }, { seq: 22 }),
      eventOf('respawned', { entity: 1, at: { x: 100, z: 100, level: 0 } }, { seq: 23 })
    ];
    const delta = diffSnapshots(before, makeSnapshot({ lastEventSeq: 23 }), events);
    const lines = renderDeltaLines(delta, nameOf);
    expect(lines).toHaveLength(events.length);
    expect(lines).toContain('Death items: kept bones×1; dropped item#995×10 to entity#2');
    expect(lines).toContain('Crafted 10 item#556 (+50 xp)');
    expect(lines).toContain('Respawned at (100,100,0)');

    const snapshot = makeSnapshot({ self: { ...before.self, status: {
      poison: { severity: 12 }, boosts: { strength: 5 }, specialEnergy: 100,
      specialEnabled: false, runEnergy: 63, weight: 0, skulledUntil: 2000,
      zoneTags: ['wilderness'], wildernessLevel: 7
    } } });
    expect(renderSnapshot(snapshot)).toContain('Poisoned (severity 12). Run 63%. Special 100%. Boosts: strength +5. Skulled until 2000. Wilderness lvl 7 — PvP risk.');
  });

  test('renders wave-3 actor state and one compact line for every state event', () => {
    const events = [
      eventOf('quest-stage', { entity: 1, quest: 'cooks-assistant', stage: 10, journal: 'Bring ingredients.' }, { seq: 1 }),
      eventOf('quest-complete', { entity: 1, quest: 'cooks-assistant', questPoints: 1 }, { seq: 2 }),
      eventOf('quest-journal', { entity: 1, quests: [{ quest: 'cooks-assistant', stage: 100, name: "Cook's Assistant", complete: true }], questPoints: 1 }, { seq: 3 }),
      eventOf('flag-set', { entity: 1, flag: 'met-cook', value: true }, { seq: 4 }),
      eventOf('slayer-assigned', { entity: 1, master: 8, task: 'Banshees', npcs: [1612], amount: 3 }, { seq: 5 }),
      eventOf('slayer-kill', { entity: 1, task: 'Banshees', remaining: 2 }, { seq: 6 }),
      eventOf('slayer-complete', { entity: 1, task: 'Banshees', points: 2, streak: 1 }, { seq: 7 }),
      eventOf('slayer-rewarded', { entity: 1, reward: 'runes', cost: 35 }, { seq: 8 }),
      eventOf('travelled', { entity: 1, network: 'ship', from: { x: 3029, z: 3217, level: 0 }, to: { x: 2956, z: 3143, level: 0 }, destination: 'Karamja' }, { seq: 9 }),
      eventOf('travel-denied', { entity: 1, network: 'ship', reason: 'no_fare' }, { seq: 10 }),
      eventOf('friends-updated', { entity: 1, friends: ['Alice'], ignored: ['Spammer'] }, { seq: 11 }),
      eventOf('clan-updated', { entity: 1, clan: { name: 'Heroes', owner: 'agent', members: [{ name: 'Agent', rank: 5 }] } }, { seq: 12 })
    ];
    const lines = renderDeltaLines(diffSnapshots(makeSnapshot(), makeSnapshot({ lastEventSeq: 12 }), events), nameOf);
    expect(lines).toHaveLength(events.length);
    expect(lines).toContain("Quest journal (1 points): Cook's Assistant stage 100 complete");
    expect(lines).toContain('Slayer kill: Banshees, 2 remaining');
    expect(lines).toContain('Travel denied by ship: no_fare');

    const snapshot = makeSnapshot({
      quests: { journal: [{ quest: 'cooks-assistant', stage: 10, name: "Cook's Assistant", complete: false, journal: 'Bring ingredients.' }], questPoints: 0 },
      slayer: { task: 'Banshees', remaining: 2 },
      social: { friends: ['Alice'], ignored: [], clan: { name: 'Heroes', owner: 'agent', members: [{ name: 'Agent', rank: 5 }] } }
    });
    const text = renderSnapshot(snapshot);
    expect(text).toContain("Quests: 0 points; Cook's Assistant stage 10 — Bring ingredients.");
    expect(text).toContain('Slayer: Banshees, 2 remaining');
    expect(text).toContain('Social: friends Alice; clan Heroes');
  });

  test('renders wave-4 state and event prose', () => {
    const at = { x: 3050, z: 3307, level: 0 };
    const events = [
      eventOf('patch-changed', { entity: 1, patch: 'falador-allotment-north', at, state: 'growing', crop: 5318, stage: 2 }, { seq: 1 }),
      eventOf('farmed', { entity: 1, patch: 'falador-allotment-north', action: 'plant', item: 5318, xp: 8 }, { seq: 2 }),
      eventOf('harvested', { entity: 1, patch: 'falador-allotment-north', item: 1942, amount: 1, xp: 9 }, { seq: 3 }),
      eventOf('trap-laid', { entity: 1, trap: 20, kind: 'bird-snare' }, { seq: 4 }),
      eventOf('trap-caught', { entity: 1, trap: 20, catch: 9978 }, { seq: 5 }),
      eventOf('trap-collapsed', { entity: 1, trap: 21 }, { seq: 6 }),
      eventOf('hunted', { entity: 1, item: 9978, xp: 34 }, { seq: 7 }),
      eventOf('familiar-summoned', { entity: 1, familiar: 30, pouch: 12047, expiresAt: 610 }, { seq: 8 }),
      eventOf('familiar-dismissed', { entity: 1, familiar: 30, reason: 'dismissed' }, { seq: 9 }),
      eventOf('summoning-points', { entity: 1, points: 8, max: 10 }, { seq: 10 }),
      eventOf('familiar-special', { entity: 1, familiar: 30, scroll: 12425, effect: 'strike' }, { seq: 11 }),
      eventOf('bob-updated', { entity: 1, familiar: 30, items: [{ item: 526, amount: 2 }] }, { seq: 12 }),
      eventOf('prospected', { entity: 1, node: 'copper-1', ore: 436 }, { seq: 13 }),
      eventOf('obstacle-completed', { entity: 1, course: 'gnome-stronghold', obstacle: 0, xp: 7.5 }, { seq: 14 }),
      eventOf('obstacle-failed', { entity: 1, course: 'wilderness', obstacle: 2, damage: 2 }, { seq: 15 }),
      eventOf('course-completed', { entity: 1, course: 'gnome-stronghold', xp: 39 }, { seq: 16 }),
      eventOf('minigame-lobby', { game: 'fight-caves', players: [{ entity: 1, ready: true }], state: 'waiting' }, { seq: 17 }),
      eventOf('minigame-started', { game: 'fight-caves', session: 'fight-caves-1', players: [1] }, { seq: 18 }),
      eventOf('minigame-event', { game: 'fight-caves', session: 'fight-caves-1', entity: 1, kind: 'wave-started', data: { wave: 1 } }, { seq: 19 }),
      eventOf('minigame-ended', { game: 'fight-caves', session: 'fight-caves-1', winner: 1, scores: [{ entity: 1, score: 63 }] }, { seq: 20 }),
      eventOf('duel-stake', { a: 1, b: 2, aStake: [], bStake: [], rules: ['no-food'] }, { seq: 21 })
    ];
    const lines = renderDeltaLines(diffSnapshots(makeSnapshot(), makeSnapshot({ lastEventSeq: 21 }), events), nameOf);
    expect(lines).toHaveLength(events.length);
    expect(lines).toContain('Patch falador-allotment-north: growing crop item#5318 stage 2');
    expect(lines).toContain('Trap entity#20 caught item#9978');
    expect(lines).toContain('Minigame fight-caves ended (fight-caves-1); winner entity#1');

    const text = renderSnapshot(makeSnapshot({
      farming: { patches: [{ id: 'falador-allotment-north', state: 'growing', crop: 5318, stage: 2 }] },
      hunter: { traps: [{ id: 20, kind: 'bird-snare', state: 'caught' }] },
      familiar: { id: 30, pouch: 12047, expiresAt: 610 }, summoningPoints: 8,
      minigame: { game: 'fight-caves', state: 'running', session: 'fight-caves-1' }
    }));
    expect(text).toContain('Farming: falador-allotment-north growing crop#5318 stage 2');
    expect(text).toContain('Hunter traps: bird-snare#20 caught');
    expect(text).toContain('Familiar entity#30, pouch#12047, expires tick 610');
    expect(text).toContain('Minigame: fight-caves running (fight-caves-1)');
  });

  test('renders wave-5 activity state and event prose', () => {
    const events = [
      eventOf('clue-step', { entity: 1, tier: 'easy', step: 0, kind: 'map', text: 'Dig beside the wall.' }, { seq: 1 }),
      eventOf('clue-advanced', { entity: 1, tier: 'easy', step: 1 }, { seq: 2 }),
      eventOf('clue-complete', { entity: 1, tier: 'easy', rewards: [{ item: 526, amount: 2 }] }, { seq: 3 }),
      eventOf('diary-progress', { entity: 1, area: 'lumbridge', level: 'easy', done: 1, total: 3, tasks: [] }, { seq: 4 }),
      eventOf('diary-complete', { entity: 1, area: 'lumbridge', level: 'easy' }, { seq: 5 }),
      eventOf('random-event-started', { entity: 1, event: 'sandwich-lady', prompt: 'Take baguette.', options: ['Baguette', 'Roll'] }, { seq: 6 }),
      eventOf('random-event-ended', { entity: 1, event: 'sandwich-lady', outcome: 'success', reward: [{ item: 526, amount: 1 }] }, { seq: 7 }),
      eventOf('shooting-star', { at: { x: 3200, z: 3201, level: 0 }, size: 9, stage: 1 }, { seq: 8 }),
      eventOf('champion-challenged', { entity: 1, champion: 'goblin' }, { seq: 9 }),
      eventOf('champion-defeated', { entity: 1, champion: 'goblin' }, { seq: 10 })
    ];
    const lines = renderDeltaLines(diffSnapshots(makeSnapshot(), makeSnapshot({ lastEventSeq: 10 }), events), nameOf);
    expect(lines).toHaveLength(events.length);
    expect(lines).toContain('Clue easy step 0 (map): Dig beside the wall.');
    expect(lines).toContain('Random event sandwich-lady: Take baguette. [Baguette, Roll]');
    expect(lines).toContain('Champion defeated: goblin');

    const text = renderSnapshot(makeSnapshot({
      clue: { tier: 'easy', step: 0, kind: 'map', text: 'Dig beside the wall.' },
      randomEvent: { event: 'sandwich-lady', prompt: 'Take baguette.', options: ['Baguette', 'Roll'] },
      diary: { area: 'lumbridge', level: 'easy', done: 1, total: 3 },
      minigame: { game: 'pest-control', state: 'running', session: 'pc-1', event: {
        kind: 'portal-shield-dropped', data: { portal: 2, entity: 44 }
      } }
    }));
    expect(text).toContain('Clue: easy step 0 (map) — Dig beside the wall.');
    expect(text).toContain('Random event: sandwich-lady — Take baguette. [Baguette, Roll]');
    expect(text).toContain('Diary: lumbridge easy 1/3');
    expect(text).toContain('latest portal-shield-dropped — entity 44, portal 2');
    expect(text).not.toContain('{"');
  });
});
