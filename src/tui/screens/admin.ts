import { BoxRenderable, type CliRenderer } from '@opentui/core';
import type { HarnessBus } from '../../core/bus.ts';
import type { RuntimeView } from '../../core/runtime.ts';
import { createChatWidget } from '../widgets/chat.ts';

export interface AdminScreen {
  readonly root: BoxRenderable;
  focus(): void;
  dispose(): void;
}

export function createAdminScreen(renderer: CliRenderer, view: RuntimeView, bus: HarnessBus): AdminScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  const chat = createChatWidget(renderer, 'admin');
  root.add(chat.root);
  for (const message of view.adminTranscript()) chat.appendMessage(message);
  const offs = [
    bus.on('admin.turn', (event) => chat.appendMessage(event.data.message)),
    bus.on('admin.tool', (event) => chat.appendTool(event.data.call, event.data.ok, event.data.result)),
    bus.on('admin.report', (event) => chat.appendMarker(`report → director: ${event.data.text}`)),
  ];
  return {
    root,
    focus() { chat.root.focus(); },
    dispose() { for (const off of offs) off(); },
  };
}
