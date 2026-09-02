import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { AgentSummary } from '../../core/runtime.ts';
import { agentHeader, agentRow } from '../format.ts';
import { theme } from '../theme.ts';

export interface AgentTableWidget {
  readonly root: BoxRenderable;
  setAgents(agents: readonly AgentSummary[], selected: number, width: number): void;
}

export function createAgentTable(renderer: CliRenderer, onKey: (name: string) => void): AgentTableWidget {
  const root = new BoxRenderable(renderer, {
    width: '100%', height: '100%', flexDirection: 'column', border: true, borderColor: theme.border,
    title: 'agents', titleColor: theme.teal, focusable: true,
    onKeyDown(key) {
      if (['up', 'down', 'return', 'p', 'r'].includes(key.name)) {
        onKey(key.name);
        key.preventDefault();
      }
    },
  });
  const header = new TextRenderable(renderer, { content: '', fg: theme.teal, height: 1, width: '100%', truncate: true });
  const rows = new TextRenderable(renderer, { content: '', fg: theme.paper, flexGrow: 1, width: '100%', truncate: true });
  root.add(header);
  root.add(rows);
  return {
    root,
    setAgents(agents, selected, width) {
      const innerWidth = Math.max(20, width - 2);
      header.content = agentHeader(innerWidth);
      rows.content = agents.map((agent, index) => `${index === selected ? '›' : ' '} ${agentRow(agent, Math.max(18, innerWidth - 2))}`).join('\n');
    },
  };
}
