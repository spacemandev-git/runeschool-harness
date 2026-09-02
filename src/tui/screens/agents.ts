import { BoxRenderable, type CliRenderer } from '@opentui/core';
import type { RuntimeCommands, RuntimeView } from '../../core/runtime.ts';
import { createAgentTable } from '../widgets/table.ts';

export interface AgentsScreen {
  readonly root: BoxRenderable;
  refresh(): void;
  focus(): void;
  selectedId(): string | undefined;
}

export function createAgentsScreen(
  renderer: CliRenderer,
  view: RuntimeView,
  commands: RuntimeCommands,
  openAgent: (id: string) => void,
): AgentsScreen {
  const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
  let agents = [...view.agents()];
  let selected = 0;
  const table = createAgentTable(renderer, (name) => {
    if (name === 'up') selected = Math.max(0, selected - 1);
    if (name === 'down') selected = Math.min(Math.max(0, agents.length - 1), selected + 1);
    const agent = agents[selected];
    if (agent !== undefined && name === 'return') openAgent(agent.id);
    if (agent !== undefined && name === 'p') commands.pauseAgent(agent.id);
    if (agent !== undefined && name === 'r') commands.resumeAgent(agent.id);
    draw();
  });
  root.add(table.root);
  const draw = (): void => table.setAgents(agents, selected, renderer.width);
  draw();
  return {
    root,
    refresh() {
      const selectedId = agents[selected]?.id;
      agents = [...view.agents()];
      if (selectedId !== undefined) {
        const next = agents.findIndex((agent) => agent.id === selectedId);
        if (next >= 0) selected = next;
      }
      selected = Math.min(selected, Math.max(0, agents.length - 1));
      draw();
    },
    focus() { table.root.focus(); },
    selectedId() { return agents[selected]?.id; },
  };
}
