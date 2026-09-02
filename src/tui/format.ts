import type { AgentSummary } from '../core/runtime.ts';
import type { HarnessEvent } from '../core/bus.ts';
import type { WorldSnapshot } from '../core/percept.ts';
import type { UsageByKey } from '../core/model.ts';
import { hpMeter } from './theme.ts';

export function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value.padEnd(width);
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

const COLUMN_NAMES = ['id', 'team', 'state', 'hp [meter]', 'pos', 'activity', 'behaviour', 'goal', 'model', 'turns', 'last wake'] as const;
const MIN_WIDTHS = [3, 2, 3, 6, 5, 4, 4, 4, 4, 3, 4] as const;
const MAX_WIDTHS = [12, 10, 12, 18, 16, 16, 16, 22, 18, 7, 12] as const;

export function agentColumnWidths(totalWidth: number): number[] {
  const separators = (COLUMN_NAMES.length - 1) * 3;
  const available = Math.max(MIN_WIDTHS.reduce((a, b) => a + b, 0), totalWidth - separators);
  const widths: number[] = [...MIN_WIDTHS];
  let remaining = available - widths.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < widths.length && remaining > 0; index += 1) {
      const width = widths[index];
      const max = MAX_WIDTHS[index];
      if (width !== undefined && max !== undefined && width < max) {
        widths[index] = width + 1;
        remaining -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return widths;
}

function joinColumns(values: readonly string[], widths: readonly number[]): string {
  return values.map((value, index) => truncate(value, widths[index] ?? 1)).join(' | ');
}

export function agentHeader(width: number): string {
  return joinColumns(COLUMN_NAMES, agentColumnWidths(width)).slice(0, Math.max(0, width));
}

export function agentRow(agent: AgentSummary, width: number): string {
  const wake = agent.lastWakeAt === undefined ? '—' : new Date(agent.lastWakeAt).toISOString().slice(11, 19);
  const hp = agent.hp === undefined ? '—' : `${agent.hp.current}/${agent.hp.max} ${hpMeter(agent.hp.current, agent.hp.max, 5)}`;
  const pos = agent.at === undefined ? '—' : `${agent.at.x},${agent.at.z},${agent.at.level}`;
  return joinColumns([
    agent.id,
    agent.team ?? '—',
    agent.state,
    hp,
    pos,
    agent.activity,
    agent.behaviour ?? '—',
    agent.goal ?? '—',
    agent.model,
    String(agent.turns),
    wake,
  ], agentColumnWidths(width)).slice(0, Math.max(0, width));
}

function tile(at: { readonly x: number; readonly z: number; readonly level: number }): string {
  return `${at.x}, ${at.z}, ${at.level}`;
}

export function snapshotText(snapshot: WorldSnapshot): string {
  const grouped = new Map<string, number>();
  for (const slot of snapshot.inventory) {
    const name = slot.name ?? `item ${slot.item}`;
    grouped.set(name, (grouped.get(name) ?? 0) + slot.amount);
  }
  const inventory = [...grouped].map(([name, amount]) => `${name} ×${amount}`).join(', ') || 'empty';
  const equipment = Object.entries(snapshot.equipment).map(([slot, item]) => `${slot}: ${item.name ?? `item ${item.item}`}`).join(', ') || 'none';
  const skills = Object.entries(snapshot.skills).filter(([, skill]) => skill.level > 1).map(([name, skill]) => `${name} ${skill.level}`).join(', ') || 'all 1';
  const objectives = snapshot.objectives.map((objective) => `${objective.complete ? '✓' : '·'} ${objective.description}`).join('\n  ') || 'none';
  const dialogue = snapshot.dialogue.active
    ? `${snapshot.dialogue.speaker ?? 'npc'}: ${snapshot.dialogue.text ?? ''}${snapshot.dialogue.options?.length ? ` / ${snapshot.dialogue.options.join(' | ')}` : ''}`
    : 'inactive';
  const prayer = snapshot.self.prayer === undefined ? '—' : `${snapshot.self.prayer.points}/${snapshot.self.prayer.maxPoints}`;
  return [
    `${snapshot.self.displayName} · ${snapshot.self.tag} · entity ${snapshot.self.entity}`,
    `tick ${snapshot.tick} · at ${tile(snapshot.self.at)}`,
    `hp ${snapshot.self.hp.current}/${snapshot.self.hp.max} ${hpMeter(snapshot.self.hp.current, snapshot.self.hp.max, 10)}`,
    `prayer ${prayer} · ${snapshot.self.dead ? 'dead' : 'alive'}`,
    `activity ${snapshot.self.activity.kind}`,
    `combat ${snapshot.self.combat.inCombat ? `target ${snapshot.self.combat.target ?? 'unknown'}` : 'clear'}`,
    `inventory (${snapshot.inventoryFree} free) ${inventory}`,
    `equipment ${equipment}`,
    `skills ${skills}`,
    `objectives\n  ${objectives}`,
    `dialogue ${dialogue}`,
  ].join('\n');
}

export function usageLine(row: UsageByKey): string {
  return `${row.key.padEnd(22)} calls ${String(row.calls).padStart(4)} · prompt ${String(row.usage.promptTokens).padStart(7)} · completion ${String(row.usage.completionTokens).padStart(7)} · errors ${row.errors}`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  return value;
}

export function compactData(data: unknown, max = 160): string {
  let text: string;
  try {
    text = JSON.stringify(data, jsonReplacer) ?? String(data);
  } catch {
    text = '[unserialisable]';
  }
  text = text.replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function eventLine(event: HarnessEvent, max = 160): string {
  const time = new Date(event.at).toISOString().slice(11, 23);
  const prefix = `${time}  ${String(event.seq).padStart(5)}  ${event.type}  `;
  return `${prefix}${compactData(event.data, Math.max(0, max - prefix.length))}`.slice(0, max);
}
