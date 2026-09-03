export const TAB_NAMES = ['Director', 'Admin', 'Agents', 'Agent', 'World', 'Trace', 'Help'] as const;
export type TabName = (typeof TAB_NAMES)[number];

export interface KeyBindingHelp {
  readonly keys: string;
  readonly action: string;
}

export const KEY_BINDINGS: readonly KeyBindingHelp[] = [
  { keys: 'Tab / Shift+Tab', action: 'focus tabs, body, or footer' },
  { keys: '1 … 7', action: 'jump to a tab (outside footer)' },
  { keys: '↑ / ↓', action: 'select an agent on Agents' },
  { keys: 'Enter', action: 'open selected agent / submit footer' },
  { keys: 'p / r', action: 'pause / resume selected agent' },
  { keys: 'Shift+[ / Shift+]', action: 'previous / next agent on Agent' },
  { keys: 'PageUp / PageDown', action: 'scroll transcripts and logs' },
  { keys: 'Home / End', action: 'scroll to top / re-stick to bottom' },
  { keys: 'Esc', action: 'clear Trace filter' },
  { keys: '?', action: 'open Help (outside footer)' },
  { keys: 'q', action: 'stop and exit (twice) / detach when attached' },
  { keys: 'Ctrl+L', action: 'redraw' },
  { keys: 'Ctrl+C twice', action: 'stop run and exit (within 2 seconds)' },
] as const;

export const HELP_TEXT = [
  'RuneSchool cockpit keys',
  '',
  ...KEY_BINDINGS.map((binding) => `${binding.keys.padEnd(22)} ${binding.action}`),
  '',
  'Footer commands',
  '/admin <text>',
  '/goal <agent> <text>',
  '/say <agent> <text>',
  '/pause <agent>',
  '/resume <agent>',
  '/cmd <agent> <type> <json>',
  '/spawn <json AgentSpec>',
  '/model director <model>',
  '/model coordinator <team> <model>',
  '/model agent <agent> <model>',
  '/stop',
  '/quit',
  '/detach',
  '/help',
  '',
  'On Trace, typing /prefix filters event types (for example /agent.mind).',
].join('\n');
