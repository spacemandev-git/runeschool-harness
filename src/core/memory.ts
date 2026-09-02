/**
 * Per-agent long-term memory. Persistent across runs, keyed by {@link AgentId}.
 * Implemented over bun:sqlite + FTS5 in `memory/sqliteStore.ts`.
 */
import type { TileCoord } from '#protocol';
import type { AgentId, RunId } from './types.ts';

export type MemoryKind =
  | 'episodic'    // "At tick 340 I reached the beacon and received a signal."
  | 'semantic'    // "Goblins (npc 100) are level 2 and drop bones."
  | 'spatial'     // "The charging station is at (12,8,0)."
  | 'procedural'  // A rule/behaviour config that worked, stored as JSON text.
  | 'journal';    // Automatic context-compaction summaries, one per compaction.

export interface MemoryRecord {
  readonly id: number;
  readonly agentId: AgentId;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly tags: readonly string[];
  readonly at?: TileCoord;
  /** 0..1, author-assigned; recall blends it with relevance and recency. */
  readonly importance: number;
  readonly runId: RunId;
  readonly createdAt: number;
  readonly lastRecalledAt?: number;
  readonly recallCount: number;
}

export interface RememberInput {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly at?: TileCoord;
  readonly importance?: number;
}

export interface RecallQuery {
  /** Free text; FTS5 match with bm25 ranking. Empty string means "recent/important only". */
  readonly text: string;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  /** Boost memories near this tile (Chebyshev on same level). */
  readonly near?: { readonly at: TileCoord; readonly radius: number };
  readonly limit?: number; // default 8, max 50
}

export interface RecallHit {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly why: readonly string[]; // e.g. ['fts', 'near', 'recent']
}

export interface MemoryStore {
  readonly agentId: AgentId;
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(query: RecallQuery): Promise<readonly RecallHit[]>;
  forget(id: number): Promise<boolean>;
  update(id: number, patch: Partial<Pick<RememberInput, 'text' | 'tags' | 'importance'>>): Promise<MemoryRecord | undefined>;
  recent(limit: number, kinds?: readonly MemoryKind[]): Promise<readonly MemoryRecord[]>;
  count(): Promise<number>;
  close(): void;
}

export interface MemoryStoreFactory {
  open(agentId: AgentId, runId: RunId): MemoryStore;
}
