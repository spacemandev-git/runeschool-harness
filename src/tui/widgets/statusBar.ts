import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { theme } from '../theme.ts';

export interface StatusBar {
  readonly root: BoxRenderable;
  setBusy(busy: boolean): void;
  setError(error?: string): void;
  setHint(hint: string): void;
}

export function createStatusBar(renderer: CliRenderer): StatusBar {
  const root = new BoxRenderable(renderer, { height: 1, width: '100%', backgroundColor: theme.ink, flexDirection: 'row' });
  const text = new TextRenderable(renderer, { content: 'ready', fg: theme.paperMuted, width: '100%', height: 1, truncate: true });
  root.add(text);
  let busy = false;
  let error: string | undefined;
  let hint = 'ready';
  const draw = (): void => {
    text.content = error ?? (busy ? 'busy…' : hint);
    text.fg = error === undefined ? (busy ? theme.teal : theme.paperMuted) : theme.damage;
  };
  return {
    root,
    setBusy(value) { busy = value; draw(); },
    setError(value) { error = value; draw(); },
    setHint(value) { hint = value; draw(); },
  };
}
