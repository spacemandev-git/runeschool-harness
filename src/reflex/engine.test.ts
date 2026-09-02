import { describe, expect, test } from 'bun:test';
import type { BehaviourDefinition, BehaviourStatus } from '../core/reflex.ts';
import { createReflexEngine } from './engine.ts';
import { FakeContext, makeSnapshot } from './testing.ts';

const rule=(id:string,priority:number,cooldownTicks?:number)=>({id,priority,cooldownTicks,when:{op:'true' as const},do:[{kind:'command' as const,type:'disengage',data:{}}]});
function definition(id:string,status:BehaviourStatus,throws=false):BehaviourDefinition{return{id,description:id,paramsSchema:{type:'object'},validate:()=>({ok:true,errors:[]}),create:(params)=>({id,params,start:async()=>{if(throws)throw new Error('boom');return status;},step:async()=>status,stop:async()=>{},describe:()=>id})};}
describe('reflex engine',()=>{
  test('orders rules by priority then id and enforces action limit',async()=>{
    const engine=createReflexEngine({agentId:'a',maxActionsPerPulse:2}); engine.installRule(rule('z',1)); engine.installRule(rule('b',2)); engine.installRule(rule('a',2));
    const ctx=new FakeContext(); await engine.pulse(ctx);
    expect(ctx.intents.map((v)=>v.source.kind==='reflex'&&v.source.id)).toEqual(['a','b']);
  });
  test('cooldown and once update counters',async()=>{
    const engine=createReflexEngine({agentId:'a'}); engine.installRule(rule('cool',1,3)); engine.installRule({...rule('once',2),once:true}); const ctx=new FakeContext();
    await engine.pulse(ctx); ctx.advance(); await engine.pulse(ctx); ctx.advance(2); await engine.pulse(ctx);
    expect(engine.state().rules.find((v)=>v.id==='cool')?.fireCount).toBe(2); expect(engine.state().rules.find((v)=>v.id==='once')?.fireCount).toBe(1);
  });
  test('queues and replaces behaviours',async()=>{
    const running=definition('running',{state:'running'}); const engine=createReflexEngine({agentId:'a',definitions:[running]}); const ctx=new FakeContext();
    const first=await engine.startBehaviour('running',{}); const second=await engine.startBehaviour('running',{}); expect(engine.state().queue).toHaveLength(1);
    await engine.pulse(ctx); const third=await engine.startBehaviour('running',{}, {replace:true});
    expect(first.ok&&second.ok&&third.ok).toBeTrue(); expect(engine.state().behaviour?.instance).toBe(third.ok?third.instance:'');
  });
  test('done and failed wake the mind, and throws never escape pulse',async()=>{
    for(const [definitionValue,reason] of [[definition('done',{state:'done',summary:'ok'}),'behaviour-finished'],[definition('failed',{state:'failed',reason:'bad',retryable:false}),'behaviour-failed'],[definition('throwing',{state:'running'},true),'behaviour-failed']] as const){
      const engine=createReflexEngine({agentId:'a',definitions:[definitionValue]}); const ctx=new FakeContext(makeSnapshot()); await engine.startBehaviour(definitionValue.id,{}); await expect(engine.pulse(ctx)).resolves.toBeUndefined(); expect(ctx.wakes[0]?.reason).toBe(reason);
    }
  });
  test('pulse swallows hostile view and invalid action failures',async()=>{
    const engine=createReflexEngine({agentId:'a'}); const installed=rule('safe',1) as unknown as {do:unknown[]}; engine.installRule(installed as never); installed.do[0]={kind:'invalid'};
    const ctx=new FakeContext(); await expect(engine.pulse(ctx)).resolves.toBeUndefined();
    const bad={...ctx,view:{...ctx.view,snapshot:()=>{throw new Error('snapshot')}}}; await expect(engine.pulse(bad as never)).resolves.toBeUndefined();
  });
});
