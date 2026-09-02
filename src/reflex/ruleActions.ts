import type { JsonValue } from '#protocol';
import type { ReflexContext, RuleAction } from '../core/reflex.ts';
import type { WorldSnapshot } from '../core/percept.ts';

export interface RuleActionEngineOps {
  startBehaviour(id: string, params: Readonly<Record<string, JsonValue>>, options?: { readonly replace?: boolean }): Promise<unknown>;
  stopBehaviour(instance?: string): Promise<boolean>;
}

export interface RuleActionContext extends ReflexContext {
  readonly engine: RuleActionEngineOps;
}

export async function planRuleAction(action: RuleAction, _snapshot: WorldSnapshot, ctx: RuleActionContext): Promise<void> {
  switch (action.kind) {
    case 'command': await ctx.act({ type: action.type, data: action.data }); return;
    case 'start-behaviour': await ctx.engine.startBehaviour(action.behaviour, action.params, { replace: action.replace }); return;
    case 'stop-behaviour': await ctx.engine.stopBehaviour(action.id); return;
    case 'wake-mind': ctx.wakeMind('reflex-fired', action.note); return;
    case 'note': ctx.log(action.text); return;
  }
}
