import type { MemoryKind } from '../core/memory.ts';
import type { WorldSnapshot } from '../core/percept.ts';
import type { WakeReason } from '../core/types.ts';

export interface DigestMemory {
  readonly id: number;
  readonly kind: MemoryKind;
  readonly text: string;
}

export interface DigestInput {
  readonly reasons: readonly WakeReason[];
  readonly snapshot: WorldSnapshot;
  readonly messages?: readonly { readonly from: string; readonly text: string; readonly at?: number }[];
  readonly deltaLines?: readonly string[];
  readonly memories?: readonly DigestMemory[];
  readonly note?: string;
  readonly fullObservation?: string;
  readonly behaviour?: { readonly id: string; readonly instance?: string; readonly description?: string };
}

function activity(snapshot: WorldSnapshot): string {
  const current = snapshot.self.activity;
  if (current.kind === 'walking' && current.dest !== undefined) {
    const dest = current.dest;
    return `walking to (${dest.x},${dest.z},${dest.level})`;
  }
  if (current.kind === 'acting' && current.action !== undefined) return current.action;
  return current.kind;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildDigest(input: DigestInput): string {
  const { snapshot } = input;
  const self = snapshot.self;
  const behaviour = input.behaviour === undefined ? 'none'
    : input.behaviour.description ?? input.behaviour.instance ?? input.behaviour.id;
  const lines = [
    `[wake: ${input.reasons.join(', ')}] tick ${snapshot.tick} · hp ${self.hp.current}/${self.hp.max} · at (${self.at.x},${self.at.z},${self.at.level}) · ${activity(snapshot)} · behaviour: ${oneLine(behaviour)}`
  ];

  if ((input.messages?.length ?? 0) > 0) {
    lines.push('Messages:');
    for (const message of input.messages ?? []) lines.push(`- from ${message.from}: ${oneLine(message.text)}`);
  }

  if (input.fullObservation !== undefined) {
    lines.push('Current observation:', input.fullObservation);
  } else if ((input.deltaLines?.length ?? 0) > 0) {
    lines.push('Since you last looked:');
    for (const line of input.deltaLines ?? []) lines.push(`- ${oneLine(line)}`);
  }

  if ((input.memories?.length ?? 0) > 0) {
    lines.push('Relevant memories:');
    for (const memory of input.memories ?? []) {
      lines.push(`- [${memory.kind}#${memory.id}] ${oneLine(memory.text)}`);
    }
  }

  if (input.note !== undefined && input.note.trim().length > 0) lines.push(`Note: ${oneLine(input.note)}`);
  return lines.join('\n');
}
