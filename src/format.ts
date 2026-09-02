import type { PerceptDelta, WorldSnapshot } from './world.ts';

function tile(at: { readonly x: number; readonly z: number; readonly level: number }): string {
  return `(${at.x},${at.z},${at.level})`;
}

/** Adapter-neutral observation rendering used by the model-facing tools. */
export function renderSnapshot(snapshot: WorldSnapshot): string {
  const nearby = snapshot.nearby
    .slice(0, 20)
    .map((entry) => `${entry.kind}#${entry.id}${entry.name === undefined ? '' : ` ${entry.name}`} at ${tile(entry.at)}`)
    .join(', ') || 'none';
  const inventory = snapshot.inventory
    .map((entry) => `${entry.name ?? `item-${entry.item}`} x${entry.amount}`)
    .join(', ') || 'empty';
  const objectives = snapshot.objectives
    .map((entry) => `${entry.complete ? 'done' : 'open'}: ${entry.description}`)
    .join('; ') || 'none';
  return [
    `World ${snapshot.instanceId} — tick ${snapshot.tick}`,
    `Self ${snapshot.self.displayName} at ${tile(snapshot.self.at)}; hp ${snapshot.self.hp.current}/${snapshot.self.hp.max}; activity ${snapshot.self.activity.kind}`,
    `Inventory (${snapshot.inventoryFree} free): ${inventory}`,
    `Nearby: ${nearby}`,
    `Objectives: ${objectives}`
  ].join('\n');
}

export function renderDeltaLines(
  delta: PerceptDelta,
  _nameOf?: (kind: string, id: number) => string | undefined
): readonly string[] {
  return [...new Set([
    ...delta.lines,
    ...delta.messages.map((message) => `message: ${message}`)
  ])];
}
