import { BoxRenderable, type CliRenderer } from '@opentui/core';
import type { HarnessBus, HarnessEvent } from '../../core/bus.ts';
import { eventLine } from '../format.ts';
import { createEventLog } from '../widgets/eventLog.ts';

export interface TraceScreen {
  readonly root: BoxRenderable;
  setFilter(prefix: string): void;
  filter(): string;
  focus(): void;
  dispose(): void;
}

export function createTraceScreen(renderer: CliRenderer, bus: HarnessBus): TraceScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  const log = createEventLog(renderer, { title: 'raw trace' });
  root.add(log.root);
  let prefix = '';
  let all = [...bus.history({ limit: 2_000 })];
  const visible = (event: HarnessEvent): boolean => prefix.length === 0 || event.type.startsWith(prefix);
  const rebuild = (): void => {
    log.clear();
    for (const event of all) if (visible(event)) log.append(eventLine(event), event.type);
  };
  rebuild();
  const off = bus.onAny((event) => {
    all.push(event);
    if (all.length > 2_000) all = all.slice(-2_000);
    if (visible(event)) log.append(eventLine(event), event.type);
  });
  return {
    root,
    setFilter(value) { prefix = value.replace(/^\//, ''); rebuild(); log.root.title = prefix ? `raw trace · /${prefix}` : 'raw trace'; },
    filter() { return prefix; },
    focus() { log.root.focus(); },
    dispose() { off(); },
  };
}
