import { describe, expect, test } from 'bun:test';
import type { RuleActionContext } from './ruleActions.ts';
import { planRuleAction } from './ruleActions.ts';
import { validateRule } from './dsl.ts';
import { FakeContext, makeSnapshot } from './testing.ts';

const withEngine = (ctx: FakeContext): FakeContext & RuleActionContext => Object.assign(ctx, { engine: { startBehaviour: async()=>({}), stopBehaviour: async()=>true } });
describe('rule actions', () => {
  test('eat chooses highest heal with slot tie-break and never eats at full hp', async () => {
    const ctx=withEngine(new FakeContext(makeSnapshot({self:{hp:{current:5,max:10}},inventory:[{slot:3,item:379,name:'Lobster',amount:1},{slot:1,item:373,name:'Swordfish',amount:1}],inventoryFree:26})));
    await planRuleAction({kind:'eat'},ctx.view.snapshot(),ctx); expect(ctx.intents[0]?.data).toEqual({item:373});
    ctx.setSnapshot(makeSnapshot({self:{hp:{current:10,max:10}},inventory:[{slot:0,item:373,amount:1}]})); await planRuleAction({kind:'eat'},ctx.view.snapshot(),ctx); expect(ctx.intents).toHaveLength(1);
  });
  test('attack tie-breaks by id and retaliate requires alive nearby attacker', async()=>{
    const nearby=[{id:3,kind:'npc' as const,at:{x:1,z:0,level:0},distance:1,lastSeenTick:0,hp:{current:2,max:2}},{id:2,kind:'npc' as const,at:{x:0,z:1,level:0},distance:1,lastSeenTick:0,hp:{current:2,max:2}}];
    const ctx=withEngine(new FakeContext(makeSnapshot({self:{at:{x:0,z:0,level:0},combat:{attackedBy:[9,3]}},nearby})));
    await planRuleAction({kind:'attack-nearest'},ctx.view.snapshot(),ctx); await planRuleAction({kind:'retaliate'},ctx.view.snapshot(),ctx);
    expect(ctx.intents.map((v)=>v.data)).toEqual([{target:2},{target:3}]);
  });
  test('attack-nearest defaults to NPCs and can target the nearest player', async () => {
    const nearby = [
      { id: 2, kind: 'player' as const, name: 'Blue Vanguard', at: { x: 1, z: 0, level: 0 }, distance: 0.5, lastSeenTick: 0, hp: { current: 70, max: 70 } },
      { id: 3, kind: 'npc' as const, name: 'Goblin', at: { x: 0, z: 1, level: 0 }, distance: 1, lastSeenTick: 0, hp: { current: 2, max: 2 } }
    ];
    const ctx = withEngine(new FakeContext(makeSnapshot({ nearby })));
    await planRuleAction({ kind: 'attack-nearest' }, ctx.view.snapshot(), ctx);
    await planRuleAction({ kind: 'attack-nearest', targetKind: 'player' }, ctx.view.snapshot(), ctx);
    await planRuleAction({ kind: 'cast', spell: 'wind-strike', target: 'nearest', targetKind: 'player' }, ctx.view.snapshot(), ctx);
    expect(ctx.intents.map((intent) => intent.data)).toEqual([
      { target: 3 },
      { target: 2 },
      { target: 2, spell: 'wind-strike' }
    ]);
  });
  test('cast targets the first alive attacker and teleport casts on self', async () => {
    const nearby = [{
      id: 3, kind: 'npc' as const, at: { x: 1, z: 0, level: 0 }, distance: 1,
      lastSeenTick: 0, hp: { current: 2, max: 2 }
    }];
    const ctx = withEngine(new FakeContext(makeSnapshot({
      self: { at: { x: 0, z: 0, level: 0 }, combat: { attackedBy: [9, 3] } }, nearby
    })));
    await planRuleAction({ kind: 'cast', spell: 'wind-strike', target: 'attacker' }, ctx.view.snapshot(), ctx);
    await planRuleAction({ kind: 'teleport', spell: 'varrock-teleport' }, ctx.view.snapshot(), ctx);
    expect(ctx.intents.map((intent) => ({ type: intent.type, data: intent.data }))).toEqual([
      { type: 'cast', data: { target: 3, spell: 'wind-strike' } },
      { type: 'cast-self', data: { spell: 'varrock-teleport' } }
    ]);
  });
  test('flee moves away and pickup walks before pickup',async()=>{
    const ctx=withEngine(new FakeContext(makeSnapshot({self:{at:{x:5,z:5,level:0},combat:{attackedBy:[2]}},nearby:[{id:2,kind:'npc',at:{x:4,z:4,level:0},distance:1,lastSeenTick:0}],groundItems:[{id:7,item:526,at:{x:9,z:5,level:0},distance:4,amount:1}]})));
    await planRuleAction({kind:'flee',distance:3},ctx.view.snapshot(),ctx); await planRuleAction({kind:'pickup-nearest'},ctx.view.snapshot(),ctx);
    expect(ctx.intents[0]?.data).toEqual({dest:{x:8,z:8,level:0}}); expect(ctx.intents[1]?.type).toBe('walk');
  });
  test('validates targetKind only against the supported target kinds', () => {
    const rule = (action: unknown) => ({ id: 'target-kind', priority: 1, when: { op: 'true' }, do: [action] });
    expect(validateRule(rule({ kind: 'attack-nearest', targetKind: 'player' })).ok).toBeTrue();
    expect(validateRule(rule({ kind: 'cast', spell: 'wind-strike', target: 'nearest', targetKind: 'any' })).ok).toBeTrue();
    expect(validateRule(rule({ kind: 'attack-nearest', targetKind: 'monster' })).errors)
      .toContainEqual({ path: 'do.0.targetKind', message: 'unknown target kind' });
    expect(validateRule(rule({ kind: 'cast', spell: 'wind-strike', target: 'current', targetKind: 'player' })).errors)
      .toContainEqual({ path: 'do.0.targetKind', message: 'is only valid for nearest targets' });
  });
});
