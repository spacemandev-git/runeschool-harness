import type { JsonValue } from '#protocol';
import type { Behaviour, BehaviourDefinition, BehaviourStatus, ReflexContext, ValidationResult } from '../../core/reflex.ts';

interface ChatParams {
  readonly text: string;
  readonly channel?: 'say' | 'pm';
  readonly to?: string;
  readonly replyToMentions?: boolean;
  readonly timeoutTicks?: number;
}
interface TemplateContext { readonly name: string; readonly text: string; readonly agent: string; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validate(value: unknown): ValidationResult {
  if (!object(value)) return { ok: false, errors: [{ path: 'params', message: 'must be an object' }] };
  const errors: { path: string; message: string }[] = [];
  if (typeof value.text !== 'string' || value.text.length === 0) errors.push({ path: 'text', message: 'must be non-empty' });
  if (value.channel !== undefined && value.channel !== 'say' && value.channel !== 'pm') errors.push({ path: 'channel', message: 'must be say or pm' });
  if (value.to !== undefined && (typeof value.to !== 'string' || value.to.length === 0)) errors.push({ path: 'to', message: 'must be non-empty' });
  if (value.channel === 'pm' && value.replyToMentions !== true && typeof value.to !== 'string') errors.push({ path: 'to', message: 'is required for a direct pm' });
  if (value.replyToMentions !== undefined && typeof value.replyToMentions !== 'boolean') errors.push({ path: 'replyToMentions', message: 'must be boolean' });
  if (value.timeoutTicks !== undefined && (!Number.isSafeInteger(value.timeoutTicks) || (value.timeoutTicks as number) <= 0)) errors.push({ path: 'timeoutTicks', message: 'must be a positive integer' });
  return { ok: errors.length === 0, errors };
}

function render(template: string, context: TemplateContext): string {
  return template.replace(/\{\{(name|text|agent)\}\}|\{(name|text|agent)\}/g, (_match, doubled: keyof TemplateContext | undefined, single: keyof TemplateContext | undefined) => context[doubled ?? single!]);
}

class ChatBehaviour implements Behaviour {
  readonly id = 'chat';
  readonly params: Readonly<Record<string, JsonValue>>;
  private readonly config: ChatParams;
  private startedTick?: number;
  private waiting = false;

  constructor(params: ChatParams) { this.config = params; this.params = params as unknown as Readonly<Record<string, JsonValue>>; }

  private async send(ctx: ReflexContext, text: string, to?: string): Promise<BehaviourStatus> {
    if (text.length > 80) return { state: 'failed', reason: 'rendered chat text exceeds 80 characters', retryable: false };
    const pm = this.config.channel === 'pm' || (this.config.channel === undefined && to !== undefined);
    const outcome = await ctx.act({ type: pm ? 'pm' : 'say', data: pm ? { to: to!, text } : { text } });
    return outcome.ok
      ? { state: 'done', summary: `${pm ? 'private' : 'public'} chat sent` }
      : { state: 'failed', reason: outcome.code ?? outcome.message ?? 'chat rejected', retryable: outcome.code === 'muted' };
  }

  private async drive(ctx: ReflexContext, initial: boolean): Promise<BehaviourStatus> {
    const snapshot = ctx.view.snapshot();
    this.startedTick ??= ctx.tick;
    if (ctx.tick - this.startedTick >= (this.config.timeoutTicks ?? 200)) return { state: 'failed', reason: 'timeout', retryable: true };
    if (!this.config.replyToMentions) {
      if (!initial) return { state: 'done', summary: 'chat sent' };
      return this.send(ctx, render(this.config.text, { name: this.config.to ?? '', text: '', agent: snapshot.self.displayName }), this.config.to);
    }
    this.waiting = true;
    const names = [snapshot.self.displayName, snapshot.self.tag, ctx.agentId]
      .map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
    const mention = ctx.pulseEvents.find((event) => event.type === 'chat'
      && event.data.entity !== snapshot.self.entity
      && names.some((name) => event.data.text.toLowerCase().includes(name)));
    if (mention === undefined || mention.type !== 'chat') return { state: 'running', note: 'waiting for a mention' };
    const to = this.config.to ?? mention.data.name;
    return this.send(ctx, render(this.config.text, {
      name: mention.data.name, text: mention.data.text, agent: snapshot.self.displayName
    }), to);
  }

  start(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, true); }
  step(ctx: ReflexContext): Promise<BehaviourStatus> { return this.drive(ctx, false); }
  async stop(_ctx: ReflexContext, _why: 'done' | 'failed' | 'replaced' | 'cancelled'): Promise<void> {}
  describe(): string { return this.waiting ? 'chat waiting for mention' : `chat ${this.config.channel ?? (this.config.to === undefined ? 'say' : 'pm')}`; }
}

export const CHAT: BehaviourDefinition = {
  id: 'chat', description: 'Send templated public/private chat, or wait for a mention and reply.',
  paramsSchema: { type: 'object', required: ['text'], additionalProperties: false, properties: {
    text: { type: 'string', description: 'Supports {name}, {text}, and {agent} placeholders.' },
    channel: { type: 'string', enum: ['say', 'pm'] }, to: { type: 'string' },
    replyToMentions: { type: 'boolean', default: false }, timeoutTicks: { type: 'integer', minimum: 1, default: 200 }
  } },
  validate, create: (params) => new ChatBehaviour(params as unknown as ChatParams)
};
