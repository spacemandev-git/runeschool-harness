import type { JsonValue } from '#protocol';
import type { ReflexContext, RuleAction } from '../core/reflex.ts';
import type { NearbyEntityView, WorldSnapshot } from '../core/percept.ts';
import { adjacent, stepAwayFrom } from './geometry.ts';
import { FOOD_HEAL, isBones, isFood } from './tables.ts';

export interface RuleActionEngineOps {
  startBehaviour(id: string, params: Readonly<Record<string, JsonValue>>, options?: { readonly replace?: boolean }): Promise<unknown>;
  stopBehaviour(instance?: string): Promise<boolean>;
}

export interface RuleActionContext extends ReflexContext {
  readonly engine: RuleActionEngineOps;
}

const nameMatches = (name: string | undefined, query: string | undefined): boolean =>
  query === undefined || (name ?? '').toLowerCase().includes(query.toLowerCase());
const kindMatches = (entity: NearbyEntityView, targetKind: 'npc' | 'player' | 'any' = 'npc'): boolean =>
  targetKind === 'any' || entity.kind === targetKind;

export async function planRuleAction(action: RuleAction, s: WorldSnapshot, ctx: RuleActionContext): Promise<void> {
  switch (action.kind) {
    case 'eat': {
      if (s.self.hp.current >= s.self.hp.max) return;
      const food = s.inventory.filter((slot) => isFood(slot.item)).sort((a, b) => {
        const ah = FOOD_HEAL[a.item] ?? 0;
        const bh = FOOD_HEAL[b.item] ?? 0;
        const byHeal = action.prefer === 'lowest-heal' ? ah - bh : bh - ah;
        return byHeal || a.slot - b.slot;
      })[0];
      if (food === undefined) { ctx.log('eat: no food in inventory'); return; }
      await ctx.act({ type: 'eat', data: { item: food.item } });
      return;
    }
    case 'attack-nearest': {
      const target = s.nearby.filter((entity) => kindMatches(entity, action.targetKind) && (entity.hp === undefined || entity.hp.current > 0) && entity.distance <= (action.radius ?? s.radius) && nameMatches(entity.name, action.name))
        .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
      if (target !== undefined) await ctx.act({ type: 'attack', data: { target: target.id } });
      return;
    }
    case 'retaliate': {
      for (const id of s.self.combat.attackedBy) {
        const target = s.nearby.find((entity) => entity.id === id && (entity.hp === undefined || entity.hp.current > 0));
        if (target !== undefined) { await ctx.act({ type: 'attack', data: { target: target.id } }); return; }
      }
      return;
    }
    case 'cast': {
      let target: NearbyEntityView | undefined;
      let targetId: number | undefined;
      const selector = action.target ?? 'attacker';
      if (selector === 'attacker') {
        for (const id of s.self.combat.attackedBy) {
          target = s.nearby.find((entity) => entity.id === id && (entity.hp === undefined || entity.hp.current > 0));
          if (target !== undefined) break;
        }
      } else if (selector === 'nearest') {
        target = s.nearby.filter((entity) => kindMatches(entity, action.targetKind)
          && (entity.hp === undefined || entity.hp.current > 0)
          && entity.distance <= (action.radius ?? s.radius)
          && nameMatches(entity.name, action.name))
          .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
      } else {
        targetId = s.self.combat.target;
      }
      targetId ??= target?.id;
      if (targetId !== undefined) {
        await ctx.act({ type: 'cast', data: { target: targetId, spell: action.spell } });
      }
      return;
    }
    case 'teleport':
      await ctx.act({ type: 'cast-self', data: { spell: action.spell } });
      return;
    case 'disengage': await ctx.act({ type: 'disengage', data: {} }); return;
    case 'pray': await ctx.act({ type: 'pray', data: { prayer: action.prayer } }); return;
    case 'pickup-nearest': {
      const item = s.groundItems.filter((ground) => ground.distance <= (action.radius ?? s.radius) && nameMatches(ground.name, action.name))
        .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
      if (item === undefined) return;
      if (!adjacent(s.self.at, item.at)) await ctx.act({ type: 'walk', data: { dest: item.at } });
      else await ctx.act({ type: 'pickup', data: { groundItem: item.id } });
      return;
    }
    case 'flee': {
      let dest = action.to;
      if (dest === undefined) {
        const candidates = s.self.combat.attackedBy.map((id) => s.nearby.find((entity) => entity.id === id && (entity.hp === undefined || entity.hp.current > 0))).filter((v) => v !== undefined);
        const threat = (candidates.length > 0 ? candidates : s.nearby.filter((entity) => entity.kind === 'npc' && (entity.hp === undefined || entity.hp.current > 0)))
          .sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
        if (threat === undefined) return;
        dest = stepAwayFrom(s.self.at, threat.at, action.distance ?? 8);
      }
      await ctx.act({ type: 'walk', data: { dest } });
      return;
    }
    case 'bury-all': {
      const bones = s.inventory.filter((slot) => isBones(slot.item)).sort((a, b) => a.slot - b.slot)[0];
      if (bones !== undefined) await ctx.act({ type: 'bury', data: { item: bones.item } });
      return;
    }
    case 'start-behaviour': await ctx.engine.startBehaviour(action.behaviour, action.params, { replace: action.replace }); return;
    case 'stop-behaviour': await ctx.engine.stopBehaviour(action.id); return;
    case 'wake-mind': ctx.wakeMind('reflex-fired', action.note); return;
    case 'note': ctx.log(action.text); return;
    case 'command': await ctx.act({ type: action.type, data: action.data }); return;
  }
}
