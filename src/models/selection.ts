import type { ModelRegistry } from '../core/model.ts';
import type { ModelSelection } from '../core/runtime.ts';

function selectionTarget(selection: ModelSelection): { readonly role: 'director' | 'coordinator' | 'agent'; readonly id?: string } {
  if (selection.role === 'director') return { role: 'director' };
  if (selection.role === 'agent-default') return { role: 'agent' };
  if (selection.role === 'coordinator') return { role: 'coordinator', id: selection.team };
  return { role: 'agent', id: selection.agent };
}

/** Apply a cockpit model assignment to the registry used by a live runtime. */
export function applyModelSelection(models: ModelRegistry, selection: ModelSelection): void {
  const model = selection.model.trim();
  if (model.length === 0) throw new Error('model must be a non-empty string');
  if (selection.role === 'director') {
    models.setRoleOverride('director', { model });
  } else if (selection.role === 'agent-default') {
    models.setRoleOverride('agent', { model });
  } else if (selection.role === 'coordinator') {
    models.setOverride(selection.team, 'coordinator', { model });
  } else {
    models.setOverride(selection.agent, 'agent', { model });
  }
}

/** Verify that the target provider advertises a model before applying the cockpit assignment. */
export async function validateAndApplyModelSelection(
  models: ModelRegistry,
  selection: ModelSelection
): Promise<void> {
  const model = selection.model.trim();
  if (model.length === 0) throw new Error('model must be a non-empty string');

  const target = selectionTarget(selection);
  const resolved = models.resolve(target.role, target.id);
  const listModels = resolved.providerInstance.listModels;
  if (listModels === undefined) {
    throw new Error(
      `provider '${resolved.provider}' does not support model discovery; cannot verify '${model}'`
    );
  }

  let available: readonly string[];
  try {
    available = await listModels.call(resolved.providerInstance);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not verify model '${model}' with provider '${resolved.provider}': ${detail}`, {
      cause: error
    });
  }

  if (!available.includes(model)) {
    throw new Error(`model '${model}' is not available from provider '${resolved.provider}'`);
  }

  applyModelSelection(models, { ...selection, model });
}
