import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { HarnessBus, HarnessEvent } from '../../core/bus.ts';
import type { RuntimeView } from '../../core/runtime.ts';
import type { ReflexEngineState } from '../../core/reflex.ts';
import { compactData, snapshotText } from '../format.ts';
import { theme } from '../theme.ts';
import { createChatWidget } from '../widgets/chat.ts';
import { createEventLog } from '../widgets/eventLog.ts';

export interface AgentScreen {
  readonly root: BoxRenderable;
  setAgent(id: string): void;
  selectedAgent(): string | undefined;
  refresh(): void;
  focus(): void;
  dispose(): void;
}

function reflexText(state: ReflexEngineState | undefined): string {
  if (state === undefined) return 'no reflex state';
  const rules = state.rules.length === 0 ? 'none' : state.rules.map((rule) => `${rule.enabled === false ? '○' : '●'} ${rule.id} · fires ${rule.fireCount}`).join('\n');
  const active = state.behaviour === undefined ? 'none' : `${state.behaviour.id} · ${state.behaviour.description}`;
  const queue = state.queue.length === 0 ? 'empty' : state.queue.map((item) => `${item.id}: ${item.description}`).join('\n');
  return `rules\n${rules}\n\nactive behaviour\n${active}\n\nqueue\n${queue}`;
}

function actionLine(event: Extract<HarnessEvent, { type: 'agent.action' }>): string {
  const outcome = event.data.outcome;
  const x = outcome.intent.data.x;
  const z = outcome.intent.data.z;
  const data = typeof x === 'number' && typeof z === 'number'
    ? ` (${x},${z})`
    : Object.values(outcome.intent.data).length === 0 ? '' : ` ${compactData(outcome.intent.data, 60).replace(/^\{|\}$/g, '')}`;
  if (outcome.ok) return `→ ${outcome.intent.type}${data} ok`;
  return `✗ ${outcome.intent.type} ${outcome.code ?? 'rejected'}: ${outcome.message ?? ''}`;
}

export function createAgentScreen(renderer: CliRenderer, view: RuntimeView, bus: HarnessBus): AgentScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'row' });
  const left = new BoxRenderable(renderer, { width: '30%', height: '100%', flexDirection: 'column' });
  const snapshotBox = new ScrollBoxRenderable(renderer, { width: '100%', height: '60%', border: true, borderColor: theme.border, title: 'percept', titleColor: theme.teal, scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true });
  const snapshot = new TextRenderable(renderer, { content: 'select an agent', fg: theme.paper, width: '100%', wrapMode: 'word' });
  snapshotBox.add(snapshot);
  const reflexBox = new ScrollBoxRenderable(renderer, { width: '100%', height: '40%', border: true, borderColor: theme.border, title: 'reflexes', titleColor: theme.teal, scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true });
  const reflex = new TextRenderable(renderer, { content: 'no reflex state', fg: theme.paperMuted, width: '100%', wrapMode: 'word' });
  reflexBox.add(reflex);
  left.add(snapshotBox);
  left.add(reflexBox);
  const events = createEventLog(renderer, { title: 'agent events' });
  events.root.width = '35%';
  const mind = createChatWidget(renderer, 'mind');
  mind.root.width = '35%';
  root.add(left);
  root.add(events.root);
  root.add(mind.root);
  let selected: string | undefined;

  const belongs = (event: HarnessEvent): boolean => {
    if (event.type === 'agent.message') return event.data.from === selected || event.data.to === selected;
    return 'agentId' in event.data && event.data.agentId === selected;
  };
  const appendEvent = (event: HarnessEvent): void => {
    if (!belongs(event)) return;
    if (event.type === 'agent.delta') for (const line of event.data.delta.lines) events.append(line, line.split(/[ :]/, 1)[0]);
    else if (event.type === 'agent.action') events.append(actionLine(event), 'agent.action');
    else if (event.type === 'agent.reflex') events.append(`⚡ ${event.data.line}`, 'agent.reflex');
    else if (event.type === 'agent.message') events.append(`✉ ${event.data.from} → ${event.data.to}: ${event.data.text}`, 'agent.message');
  };
  const appendMind = (event: HarnessEvent): void => {
    if (!belongs(event)) return;
    if (event.type === 'agent.mind.wake') mind.appendMarker(`⏰ wake: ${event.data.reasons.join(', ')}${event.data.note ? ` — ${event.data.note}` : ''}`);
    else if (event.type === 'agent.mind.turn') mind.appendMessage(event.data.message);
    else if (event.type === 'agent.mind.tool') mind.appendTool(event.data.call, event.data.ok, event.data.result);
    else if (event.type === 'agent.mind.compact') mind.appendMarker(`⌁ compact: dropped ${event.data.droppedMessages} — ${event.data.summary}`);
  };
  const off = bus.onAny((event) => { appendEvent(event); appendMind(event); });

  const setAgent = (id: string): void => {
    selected = id;
    events.clear();
    mind.clear();
    for (const message of view.agentTranscript(id)) mind.appendMessage(message);
    for (const event of bus.history({ limit: 2_000 })) appendEvent(event);
    refresh();
  };
  const refresh = (): void => {
    if (selected === undefined) return;
    const world = view.agentSnapshot(selected);
    snapshot.content = world === undefined ? `agent ${selected}\nno snapshot` : snapshotText(world);
    reflex.content = reflexText(view.agentReflexes(selected));
    snapshotBox.title = `percept · ${selected}`;
  };
  return {
    root,
    setAgent,
    selectedAgent() { return selected; },
    refresh,
    focus() { events.root.focus(); },
    dispose() { off(); },
  };
}
