import { describe, expect, test } from 'bun:test';
import type { Expr, RefPath } from '../core/reflex.ts';
import { evaluate, resolveRef, validateExpr, validateRule } from './dsl.ts';
import { makeEvent, makeSnapshot } from './testing.ts';

describe('reflex DSL', () => {
  const snapshot = makeSnapshot({ tick: 10, inventoryFree: 26, inventory: [{ slot: 0, item: 379, name: 'Lobster', amount: 2 }], skills: { Attack: { level: 5, xp: 100 } }, self: { hp: { current: 5, max: 10 }, prayer: { points: 2, maxPoints: 4, active: [] }, combat: { inCombat: true, attackedBy: [2], bound: true, style: { style: 'magic', attackStyle: 'cast', spell: 'wind-strike' } }, activity: { kind: 'idle' } }, nearby: [{ id: 2, kind: 'npc', name: 'Goblin', at: { x: 3201, z: 3200, level: 0 }, distance: 1, hp: { current: 2, max: 5 }, lastSeenTick: 10 }, { id: 3, kind: 'player', at: { x: 3202, z: 3200, level: 0 }, distance: 2, lastSeenTick: 10 }], groundItems: [{ id: 4, item: 526, name: 'Bones', amount: 1, at: { x: 3201, z: 3200, level: 0 }, distance: 1 }], dialogue: { active: true, options: ['Yes'] }, won: true });
  test('resolves every RefPath', () => {
    const paths: RefPath[] = ['self.hp.current','self.hp.max','self.hp.fraction','self.prayer.points','self.prayer.fraction','self.inCombat','self.attackedBy.count','self.dead','self.bound','self.autocast','self.activity','self.at.x','self.at.z','self.at.level','inventory.free','inventory.used','nearby.npcs.count','nearby.players.count','groundItems.count','dialogue.active','dialogue.hasOptions','objectives.won','objectives.lost','tick'];
    for (const path of paths) expect(resolveRef(path, snapshot)).not.toBeUndefined();
  });
  test('evaluates every expression op positively and negatively', () => {
    const event = makeEvent('died', { entity: 2, killer: 1 }, 10);
    const expressions: Expr[] = [{ op:'true' },{ op:'not',arg:{op:'false'}},{op:'and',args:[{op:'true'},{op:'true'}]},{op:'or',args:[{op:'false'},{op:'true'}]},{op:'lt',ref:'self.hp.current',value:6},{op:'le',ref:'self.hp.current',value:5},{op:'gt',ref:'tick',value:9},{op:'ge',ref:'tick',value:10},{op:'eq',ref:'self.activity',value:'idle'},{op:'ne',ref:'self.activity',value:'walking'},{op:'has-item',item:'lob',min:2},{op:'has-food'},{op:'skill-at-least',skill:'attack',level:5},{op:'nearby',kind:'npc',name:'gob',radius:2},{op:'event',type:'died'},{op:'behaviour-running',id:'fight'}];
    for (const expr of expressions) expect(evaluate(expr, snapshot, [event], { behaviourRunning: (id) => id === 'fight' })).toBeTrue();
    const negative: Expr[]=[{op:'false'},{op:'not',arg:{op:'true'}},{op:'and',args:[{op:'true'},{op:'false'}]},{op:'or',args:[{op:'false'},{op:'false'}]},{op:'lt',ref:'tick',value:9},{op:'le',ref:'tick',value:9},{op:'gt',ref:'tick',value:11},{op:'ge',ref:'tick',value:11},{op:'eq',ref:'self.activity',value:'walking'},{op:'ne',ref:'self.activity',value:'idle'},{op:'has-item',item:999},{op:'skill-at-least',skill:'attack',level:6},{op:'nearby',kind:'npc',name:'dragon'},{op:'event',type:'died',withinTicks:0},{op:'behaviour-running',id:'walk-to'}];
    for(const expr of negative)expect(evaluate(expr,snapshot,[makeEvent('died',{entity:2},9)],{behaviourRunning:()=>false})).toBeFalse();
    expect(evaluate({op:'has-food'},makeSnapshot(),[],{behaviourRunning:()=>false})).toBeFalse();
  });
  test('reports paths, bad literal types, unknown ops, and depth', () => {
    expect(validateExpr({ op:'eq', ref:'wat', value:1 }).errors[0]?.path).toBe('when.ref');
    expect(validateExpr({ op:'lt', ref:'self.hp.current', value:'five' }).errors.some((e)=>e.path==='when.value')).toBeTrue();
    expect(validateExpr({ op:'wat' }).errors[0]?.path).toBe('when.op');
    let deep: unknown = { op:'true' }; for (let i=0;i<9;i++) deep={op:'not',arg:deep};
    expect(validateExpr(deep).ok).toBeFalse();
    expect(validateRule({ id:'Bad!', priority:Infinity, when:{op:'true'}, do:[] }).ok).toBeFalse();
  });
  test('type-mismatch comparisons are false', () => {
    expect(evaluate({ op:'eq', ref:'tick', value:'10' } as Expr, snapshot, [], { behaviourRunning:()=>false })).toBeFalse();
    expect(evaluate({ op:'ne', ref:'tick', value:'10' } as Expr, snapshot, [], { behaviourRunning:()=>false })).toBeFalse();
    expect(evaluate({ op:'lt', ref:'tick', value:'20' } as Expr, snapshot, [], { behaviourRunning:()=>false })).toBeFalse();
  });
  test('validates magic rule actions against the spell catalogue', () => {
    const rule = (action: unknown) => ({ id: 'magic-rule', priority: 1, when: { op: 'true' }, do: [action] });
    expect(validateRule(rule({ kind: 'cast', spell: 'wind-strike', target: 'attacker' })).ok).toBeTrue();
    expect(validateRule(rule({ kind: 'teleport', spell: 'varrock-teleport' })).ok).toBeTrue();
    expect(validateRule(rule({ kind: 'cast', spell: 'varrock-teleport' })).errors)
      .toContainEqual({ path: 'do.0.spell', message: 'must be an entity spell id' });
    expect(validateRule(rule({ kind: 'teleport', spell: 'wind-strike' })).errors)
      .toContainEqual({ path: 'do.0.spell', message: 'must be a teleport spell id' });
    expect(validateRule(rule({ kind: 'cast', spell: 'not-a-spell' })).ok).toBeFalse();
    expect(resolveRef('self.bound', snapshot)).toBe(1);
    expect(resolveRef('self.autocast', snapshot)).toBe('wind-strike');
  });
});
