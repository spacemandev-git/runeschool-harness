import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { HELP_TEXT } from '../keymap.ts';
import { theme } from '../theme.ts';

export interface HelpScreen {
  readonly root: BoxRenderable;
  focus(): void;
}

export function createHelpScreen(renderer: CliRenderer): HelpScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  const scroll = new ScrollBoxRenderable(renderer, { width: '100%', height: '100%', border: true, borderColor: theme.border, title: 'help', titleColor: theme.teal, scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true });
  scroll.add(new TextRenderable(renderer, { content: HELP_TEXT, fg: theme.paper, width: '100%', wrapMode: 'word' }));
  root.add(scroll);
  return { root, focus() { scroll.focus(); } };
}
