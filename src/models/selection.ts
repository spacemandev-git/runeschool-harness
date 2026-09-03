import type { ModelRegistry } from '../core/model.ts';
import type { ModelSelection } from '../core/runtime.ts';

/** Apply a cockpit model assignment to the registry used by a live runtime. */
export function applyModelSelection(models: ModelRegistry, selection: ModelSelection): void {
  const model = selection.model.trim();
  if (model.length === 0) throw new Error('model must be a non-empty string');
  if (selection.role === 'director') {
    models.setRoleOverride('director', { model });
  } else if (selection.role === 'coordinator') {
    models.setOverride(selection.team, 'coordinator', { model });
  } else {
    models.setOverride(selection.agent, 'agent', { model });
  }
}
