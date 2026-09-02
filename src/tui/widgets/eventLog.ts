import { ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { eventKindColor, theme } from '../theme.ts';

export const LOG_ROW_CAP = 2_000;

export interface EventLogWidget {
  readonly root: ScrollBoxRenderable;
  append(line: string, kind?: string): void;
  clear(): void;
  readonly rowCount: number;
}

export function createEventLog(renderer: CliRenderer, options: { readonly title?: string } = {}): EventLogWidget {
  const root = new ScrollBoxRenderable(renderer, {
    width: '100%', height: '100%', border: true, borderColor: theme.border,
    title: options.title, titleColor: theme.teal, stickyScroll: true, stickyStart: 'bottom',
    scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true,
    onKeyDown(key) {
      if (key.name === 'end') { root.stickyScroll = true; root.scrollTo(Number.MAX_SAFE_INTEGER); key.preventDefault(); }
      else if (key.name === 'home') { root.stickyScroll = false; root.scrollTo(0); key.preventDefault(); }
      else if (key.name === 'pageup') { root.stickyScroll = false; root.scrollBy(-10); key.preventDefault(); }
      else if (key.name === 'pagedown') { root.scrollBy(10); key.preventDefault(); }
    },
  });
  const rows: TextRenderable[] = [];
  const append = (line: string, kind = 'world'): void => {
    const row = new TextRenderable(renderer, { content: line, fg: eventKindColor(kind), width: '100%', height: 1, truncate: true });
    rows.push(row);
    root.add(row);
    if (rows.length > LOG_ROW_CAP) {
      const removed = rows.splice(0, rows.length - LOG_ROW_CAP);
      for (const child of removed) { root.remove(child); child.destroy(); }
    }
  };
  return {
    root,
    append,
    clear() { for (const row of rows.splice(0)) { root.remove(row); row.destroy(); } },
    get rowCount() { return rows.length; },
  };
}
