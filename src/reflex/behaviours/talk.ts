import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface TalkParams { readonly dialogue: string; readonly choices?: readonly number[]; readonly maxNodes?: number; }
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validate(value: unknown): ValidationResult {
  const errors: { path: string; message: string }[] = [];
  if (!obj(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  if (typeof value.dialogue !== 'string' || value.dialogue.length === 0) errors.push({ path: 'dialogue', message: 'must be non-empty' });
  if (value.choices !== undefined && (!Array.isArray(value.choices) || value.choices.some((v) => !Number.isSafeInteger(v) || v < 0))) errors.push({ path: 'choices', message: 'must be non-negative integers' });
  if (value.maxNodes !== undefined && (!Number.isSafeInteger(value.maxNodes) || (value.maxNodes as number) <= 0)) errors.push({ path: 'maxNodes', message: 'must be positive' });
  return { ok: errors.length === 0, errors };
}
class TalkBehaviour implements Behaviour {
  readonly id = 'talk'; readonly params: Readonly<Record<string, JsonValue>>; private readonly config: TalkParams; private nodes = 0; private choice = 0;
  constructor(params: TalkParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }
  async start(ctx: ReflexContext): Promise<BehaviourStatus> { const out = await ctx.act({ type: 'talk', data: { dialogue: this.config.dialogue } }); return out.ok ? { state: 'running', note: 'dialogue started' } : { state: 'failed', reason: out.code ?? out.message ?? 'talk rejected', retryable: false }; }
  async step(ctx: ReflexContext): Promise<BehaviourStatus> {
    if (ctx.pulseEvents.some((e) => e.type === 'dialogue-ended' && e.data.dialogue === this.config.dialogue)) return { state: 'done', summary: 'dialogue ended' };
    let node: Extract<(typeof ctx.pulseEvents)[number], { type: 'dialogue-node' }> | undefined;
    for (const event of ctx.pulseEvents) if (event.type === 'dialogue-node' && event.data.dialogue === this.config.dialogue) { node = event; break; }
    if (node === undefined) return { state: 'running', note: `${this.nodes} nodes` };
    if (++this.nodes > (this.config.maxNodes ?? 30)) return { state: 'failed', reason: 'max nodes exceeded', retryable: false };
    const data = node.data.kind === 'choice' ? { choice: this.config.choices?.[this.choice++] ?? 0 } : {};
    const out = await ctx.act({ type: 'dialogue-advance', data });
    return out.ok ? { state: 'running', note: `${this.nodes} nodes` } : { state: 'failed', reason: out.code ?? out.message ?? 'dialogue rejected', retryable: false };
  }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return `talk ${this.config.dialogue} (${this.nodes}/${this.config.maxNodes ?? 30})`.slice(0, 80); }
}
export const TALK: BehaviourDefinition = { id: 'talk', description: 'Follow a command-driven dialogue.', paramsSchema: { type: 'object', required: ['dialogue'], properties: { dialogue: { type: 'string' }, choices: { type: 'array', items: { type: 'number' } }, maxNodes: { type: 'number', default: 30 } } }, validate, create: (params) => new TalkBehaviour(params as unknown as TalkParams) };
