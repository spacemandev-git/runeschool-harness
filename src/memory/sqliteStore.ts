import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessBus } from '../core/bus.ts';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemoryStoreFactory,
  RecallHit,
  RecallQuery,
  RememberInput
} from '../core/memory.ts';
import type { AgentId, RunId } from '../core/types.ts';
import { calculateRecallScore, normalizeBm25 } from './ranking.ts';

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DAY_MS = 86_400_000;
const KINDS = new Set<MemoryKind>(['episodic', 'semantic', 'spatial', 'procedural', 'journal']);

export interface SqliteMemoryFactoryOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly bus?: HarnessBus;
}

interface MemoryRow {
  readonly id: number;
  readonly kind: string;
  readonly text: string;
  readonly tags: string;
  readonly at_x: number | null;
  readonly at_z: number | null;
  readonly at_level: number | null;
  readonly importance: number;
  readonly run_id: string;
  readonly created_at: number;
  readonly last_recalled_at: number | null;
  readonly recall_count: number;
  readonly rank?: number;
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  const normalized = [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > 16) throw new Error('Memory tags must contain at most 16 unique values');
  return normalized;
}

function normalizeText(text: string): string {
  const normalized = text.trim();
  if (normalized.length === 0) throw new Error('Memory text must not be empty');
  if (normalized.length > 2_000) throw new Error('Memory text must be at most 2000 characters');
  return normalized;
}

function clampImportance(value: number | undefined): number {
  const importance = value ?? 0.5;
  if (!Number.isFinite(importance)) throw new Error('Memory importance must be finite');
  return Math.max(0, Math.min(1, importance));
}

function parseTags(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
    throw new Error('Stored memory tags are malformed');
  }
  return parsed;
}

function toRecord(row: MemoryRow, agentId: AgentId): MemoryRecord {
  const at = row.at_x === null || row.at_z === null || row.at_level === null
    ? undefined
    : { x: row.at_x, z: row.at_z, level: row.at_level };
  return {
    id: row.id,
    agentId,
    kind: row.kind as MemoryKind,
    text: row.text,
    tags: parseTags(row.tags),
    ...(at === undefined ? {} : { at }),
    importance: row.importance,
    runId: row.run_id,
    createdAt: row.created_at,
    ...(row.last_recalled_at === null ? {} : { lastRecalledAt: row.last_recalled_at }),
    recallCount: row.recall_count
  };
}

function sanitizeFtsQuery(text: string): string | undefined {
  const operators = new Set(['and', 'or', 'not', 'near']);
  const tokens = text.match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((token) => !operators.has(token.toLowerCase())) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

function createSchema(database: Database): void {
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS memories(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL,
      at_x INTEGER,
      at_z INTEGER,
      at_level INTEGER,
      importance REAL NOT NULL,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_recalled_at INTEGER,
      recall_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      tags,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags)
      VALUES ('delete', old.id, old.text, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags)
      VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('schema_version', '1')
      ON CONFLICT(key) DO NOTHING;
  `);
}

class SqliteMemoryStore implements MemoryStore {
  private refs = 1;
  private closed = false;

  constructor(
    readonly agentId: AgentId,
    private readonly runId: RunId,
    private readonly database: Database,
    private readonly now: () => number,
    private readonly bus: HarnessBus | undefined,
    private readonly onFinalClose: () => void
  ) {}

  addRef(): void {
    if (this.closed) throw new Error(`Memory store for ${this.agentId} is closed`);
    this.refs++;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Memory store for ${this.agentId} is closed`);
  }

  private row(id: number): MemoryRow | undefined {
    return this.database.query<MemoryRow, [number]>('SELECT * FROM memories WHERE id = ?').get(id) ?? undefined;
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    this.assertOpen();
    if (!KINDS.has(input.kind)) throw new Error(`Unknown memory kind: ${input.kind}`);
    const text = normalizeText(input.text);
    const tags = normalizeTags(input.tags);
    const importance = clampImportance(input.importance);
    const createdAt = this.now();
    const result = this.database.run(
      `INSERT INTO memories(kind, text, tags, at_x, at_z, at_level, importance, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.kind,
        text,
        JSON.stringify(tags),
        input.at?.x ?? null,
        input.at?.z ?? null,
        input.at?.level ?? null,
        importance,
        this.runId,
        createdAt
      ]
    );
    const id = Number(result.lastInsertRowid);
    const row = this.row(id);
    if (row === undefined) throw new Error(`Failed to read newly inserted memory ${id}`);
    this.bus?.emit('agent.memory', {
      agentId: this.agentId,
      op: 'remember',
      detail: `id=${id} kind=${input.kind}`
    });
    return toRecord(row, this.agentId);
  }

  async recall(query: RecallQuery): Promise<readonly RecallHit[]> {
    this.assertOpen();
    const limit = Math.max(0, Math.min(50, Math.floor(query.limit ?? 8)));
    const fts = sanitizeFtsQuery(query.text);
    const params: (string | number)[] = [];
    const clauses: string[] = [];
    if (query.kinds !== undefined && query.kinds.length > 0) {
      clauses.push(`m.kind IN (${query.kinds.map(() => '?').join(', ')})`);
      params.push(...query.kinds);
    }
    for (const tag of normalizeTags(query.tags)) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(m.tags) WHERE lower(value) = ?)');
      params.push(tag);
    }
    const filters = clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`;
    let rows: MemoryRow[];
    if (fts === undefined) {
      rows = this.database.query(`SELECT m.* FROM memories m WHERE 1=1${filters}
        ORDER BY m.created_at DESC LIMIT 200`).all(...params) as MemoryRow[];
    } else {
      rows = this.database.query(`SELECT m.*, bm25(memories_fts) AS rank
        FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?${filters}`).all(fts, ...params) as MemoryRow[];
    }

    const relevance = fts === undefined
      ? rows.map(() => 1)
      : normalizeBm25(rows.map((row) => row.rank ?? 0));
    const recalledAt = this.now();
    const scored = rows.map((row, index) => {
      const sameLevel = query.near !== undefined && row.at_level !== null
        && row.at_level === query.near.at.level;
      const distance = query.near === undefined || row.at_x === null || row.at_z === null
        ? undefined
        : Math.max(Math.abs(row.at_x - query.near.at.x), Math.abs(row.at_z - query.near.at.z));
      const result = calculateRecallScore({
        relevance: relevance[index] ?? 0,
        ageDays: (recalledAt - row.created_at) / DAY_MS,
        importance: row.importance,
        ...(distance === undefined ? {} : { distance }),
        ...(query.near === undefined ? {} : { radius: query.near.radius, sameLevel })
      });
      const why = fts === undefined ? result.why.filter((reason) => reason !== 'fts') : result.why;
      return { row, score: result.score, why };
    }).sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at || b.row.id - a.row.id)
      .slice(0, limit);

    const bump = this.database.transaction((ids: readonly number[]) => {
      const statement = this.database.query<unknown, [number, number]>(
        'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?'
      );
      for (const id of ids) statement.run(recalledAt, id);
    });
    bump(scored.map(({ row }) => row.id));
    const hits = scored.map(({ row, score, why }): RecallHit => ({
      record: toRecord({
        ...row,
        recall_count: row.recall_count + 1,
        last_recalled_at: recalledAt
      }, this.agentId),
      score,
      why
    }));
    this.bus?.emit('agent.memory', {
      agentId: this.agentId,
      op: 'recall',
      detail: `hits=${hits.length} text=${fts === undefined ? 'empty' : 'fts'}`
    });
    return hits;
  }

  async forget(id: number): Promise<boolean> {
    this.assertOpen();
    const result = this.database.run('DELETE FROM memories WHERE id = ?', [id]);
    const forgotten = result.changes > 0;
    this.bus?.emit('agent.memory', {
      agentId: this.agentId,
      op: 'forget',
      detail: `id=${id} forgotten=${forgotten}`
    });
    return forgotten;
  }

  async update(
    id: number,
    patch: Partial<Pick<RememberInput, 'text' | 'tags' | 'importance'>>
  ): Promise<MemoryRecord | undefined> {
    this.assertOpen();
    const existing = this.row(id);
    if (existing === undefined) return undefined;
    const text = patch.text === undefined ? existing.text : normalizeText(patch.text);
    const tags = patch.tags === undefined ? existing.tags : JSON.stringify(normalizeTags(patch.tags));
    const importance = patch.importance === undefined ? existing.importance : clampImportance(patch.importance);
    this.database.run('UPDATE memories SET text = ?, tags = ?, importance = ? WHERE id = ?', [
      text,
      tags,
      importance,
      id
    ]);
    const updated = this.row(id);
    return updated === undefined ? undefined : toRecord(updated, this.agentId);
  }

  async recent(limit: number, kinds?: readonly MemoryKind[]): Promise<readonly MemoryRecord[]> {
    this.assertOpen();
    const safeLimit = Math.max(0, Math.floor(limit));
    const params: (string | number)[] = [];
    let where = '';
    if (kinds !== undefined && kinds.length > 0) {
      where = ` WHERE kind IN (${kinds.map(() => '?').join(', ')})`;
      params.push(...kinds);
    }
    params.push(safeLimit);
    const rows = this.database.query(`SELECT * FROM memories${where}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params) as MemoryRow[];
    return rows.map((row) => toRecord(row, this.agentId));
  }

  async count(): Promise<number> {
    this.assertOpen();
    const row = this.database.query<{ readonly count: number }, []>('SELECT count(*) AS count FROM memories').get();
    return row?.count ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.refs--;
    if (this.refs > 0) return;
    this.closed = true;
    this.database.close();
    this.onFinalClose();
  }
}

export function createSqliteMemoryFactory(options: SqliteMemoryFactoryOptions): MemoryStoreFactory {
  const stores = new Map<AgentId, SqliteMemoryStore>();
  const now = options.now ?? Date.now;
  return {
    open(agentId, runId): MemoryStore {
      if (!AGENT_ID.test(agentId)) {
        throw new Error(`Invalid agentId ${JSON.stringify(agentId)}; expected ${AGENT_ID.source}`);
      }
      const existing = stores.get(agentId);
      if (existing !== undefined) {
        existing.addRef();
        return existing;
      }
      const directory = join(options.dataDir, 'agents', agentId);
      mkdirSync(directory, { recursive: true });
      const database = new Database(join(directory, 'memory.sqlite'), { create: true });
      createSchema(database);
      const store = new SqliteMemoryStore(
        agentId,
        runId,
        database,
        now,
        options.bus,
        () => { stores.delete(agentId); }
      );
      stores.set(agentId, store);
      return store;
    }
  };
}
