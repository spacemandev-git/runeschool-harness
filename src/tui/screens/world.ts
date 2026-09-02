import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { RuntimeView } from '../../core/runtime.ts';
import { usageLine } from '../format.ts';
import { theme } from '../theme.ts';

export interface WorldScreen {
  readonly root: BoxRenderable;
  refresh(): void;
  focus(): void;
}

export function createWorldScreen(renderer: CliRenderer, view: RuntimeView): WorldScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  const scroll = new ScrollBoxRenderable(renderer, { width: '100%', height: '100%', border: true, borderColor: theme.border, title: 'world', titleColor: theme.teal, scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true });
  const text = new TextRenderable(renderer, { content: '', fg: theme.paper, width: '100%', wrapMode: 'word' });
  scroll.add(text);
  root.add(scroll);
  const refresh = (): void => {
    const instance = view.instance;
    const teams = view.teams();
    text.content = [
      'INSTANCE',
      instance === undefined ? 'not provisioned' : `id ${instance.id}\nkind ${instance.kind}\ntick ${instance.tick}\nhttp ${instance.httpUrl}\nwatch ${instance.watchUrl ?? '—'}`,
      '',
      'TEAMS',
      ...(teams.length === 0 ? ['none'] : teams.map((team) => `${team.id} · ${team.mission}\n  members ${team.agents.join(', ')}\n  model ${team.coordinatorModel}\n  report ${team.lastReport ?? '—'}`)),
      '',
      'USAGE',
      ...(view.usage().length === 0 ? ['none'] : view.usage().map(usageLine)),
      '',
      'REDACTED CONFIG',
      JSON.stringify(view.config(), null, 2),
    ].join('\n');
  };
  refresh();
  return { root, refresh, focus() { scroll.focus(); } };
}
