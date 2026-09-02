import { BoxRenderable, type CliRenderer } from '@opentui/core';
import type { HarnessBus } from '../../core/bus.ts';
import type { RuntimeView } from '../../core/runtime.ts';
import { createChatWidget } from '../widgets/chat.ts';

export interface DirectorScreen {
  readonly root: BoxRenderable;
  focus(): void;
  dispose(): void;
}

export function createDirectorScreen(renderer: CliRenderer, view: RuntimeView, bus: HarnessBus): DirectorScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  const chat = createChatWidget(renderer, 'director');
  root.add(chat.root);
  for (const message of view.directorTranscript()) chat.appendMessage(message);
  const offs = [
    bus.on('director.turn', (event) => chat.appendMessage(event.data.message)),
    bus.on('director.tool', (event) => chat.appendTool(event.data.call, event.data.ok, event.data.result)),
  ];
  return {
    root,
    focus() { chat.root.focus(); },
    dispose() { for (const off of offs) off(); },
  };
}
