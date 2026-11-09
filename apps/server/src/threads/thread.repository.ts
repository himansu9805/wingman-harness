import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const THREAD_REPOSITORY = Symbol("THREAD_REPOSITORY");

export interface ScheduledThread {
  taskId: string;
  taskRunId: string;
  originThreadId: string | null;
}

export interface ThreadRecord {
  source: "chat" | "scheduled";
  scheduled: ScheduledThread | null;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  deleting: boolean;
}

type ListOptions = { limit: number; cursor?: { updatedAt: string; id: string } };
type ThreadPage = { items: ThreadRecord[]; hasMore: boolean };

export interface ThreadRepository {
  init(): Promise<void>;
  create(id: string, scheduled?: ScheduledThread): Promise<ThreadRecord>;
  get(id: string): Promise<ThreadRecord | null>;
  list(options: ListOptions): Promise<ThreadPage>;
  touch(id: string, message?: string): Promise<void>;
  /** Atomically save the fallback and claim title generation only for the first message. */
  startMessage(id: string, message: string): Promise<string | null>;
  markDeleting(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

function firstTitle(message: string): string {
  return Array.from(message.trim()).slice(0, 80).join("") || "New conversation";
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Thread list limit must be a positive safe integer");
  }
}

type ThreadRow = {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  deleting: boolean;
  scheduled: ScheduledThread | null;
};

function record(row: ThreadRow): ThreadRecord {
  return {
    source: row.scheduled ? "scheduled" : "chat",
    scheduled: row.scheduled ?? null,
    id: row.id,
    title: row.title ?? "New conversation",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deleting: row.deleting,
  };
}

export class PostgresThreadRepository implements ThreadRepository {
  private poolPromise?: Promise<Pool>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly connectionString: string) {
    if (!connectionString.trim()) throw new Error("Postgres connection string is required");
  }

  private pool(): Promise<Pool> {
    if (this.closed) return Promise.reject(new Error("Thread repository is closed"));
    return (this.poolPromise ??= import("pg").then(
      ({ Pool }) =>
        new Pool({
          connectionString: this.connectionString,
        }),
    ));
  }

  async init(): Promise<void> {
    try {
      const pool = await this.pool();
      await pool.query(`CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
        deleting BOOLEAN NOT NULL DEFAULT false
      )`);
      await pool.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS scheduled JSONB`);
      await pool.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS title_generation_id UUID`);
      await pool.query(`CREATE INDEX IF NOT EXISTS threads_updated_idx
        ON threads (updated_at DESC, id COLLATE "C" DESC) WHERE deleting = false`);
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async create(id: string, scheduled?: ScheduledThread): Promise<ThreadRecord> {
    const pool = await this.pool();
    const result = await pool.query<ThreadRow>(
      `INSERT INTO threads (id, scheduled) VALUES ($1, $2::jsonb) RETURNING *`,
      [id, scheduled ? JSON.stringify(scheduled) : null],
    );
    return record(result.rows[0]);
  }

  async get(id: string): Promise<ThreadRecord | null> {
    const result = await (
      await this.pool()
    ).query<ThreadRow>(`SELECT * FROM threads WHERE id = $1`, [id]);
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async list({ limit, cursor }: ListOptions): Promise<ThreadPage> {
    checkLimit(limit);
    const result = await (
      await this.pool()
    ).query<ThreadRow>(
      `SELECT * FROM threads WHERE deleting = false
       ${cursor ? 'AND (updated_at, id COLLATE "C") < ($2::timestamptz, $3::text COLLATE "C")' : ""}
       ORDER BY updated_at DESC, id COLLATE "C" DESC LIMIT $1`,
      cursor ? [limit + 1, cursor.updatedAt, cursor.id] : [limit + 1],
    );
    return { items: result.rows.slice(0, limit).map(record), hasMore: result.rows.length > limit };
  }

  async touch(id: string, message?: string): Promise<void> {
    await (
      await this.pool()
    ).query(
      `UPDATE threads SET updated_at = NOW(), title = COALESCE(title, $2) WHERE id = $1 AND deleting = false`,
      [id, message === undefined ? null : firstTitle(message)],
    );
  }

  async startMessage(id: string, message: string): Promise<string | null> {
    const claim = randomUUID();
    const result = await (
      await this.pool()
    ).query<{ title_generation_id: string | null }>(
      `UPDATE threads SET updated_at = NOW(), title = COALESCE(title, $2),
       title_generation_id = CASE WHEN title IS NULL THEN $3::uuid ELSE title_generation_id END
       WHERE id = $1 AND deleting = false RETURNING title_generation_id`,
      [id, firstTitle(message), claim],
    );
    return result.rows[0]?.title_generation_id === claim ? claim : null;
  }

  async markDeleting(id: string): Promise<void> {
    await (await this.pool()).query(`UPDATE threads SET deleting = true WHERE id = $1`, [id]);
  }

  async delete(id: string): Promise<void> {
    await (await this.pool()).query(`DELETE FROM threads WHERE id = $1`, [id]);
  }

  close(): Promise<void> {
    this.closed = true;
    return (this.closePromise ??= (async () => {
      if (this.poolPromise) await (await this.poolPromise).end();
    })());
  }
}

export class MemoryThreadRepository implements ThreadRepository {
  private readonly rows = new Map<string, Omit<ThreadRecord, "title"> & { title: string | null }>();
  private closed = false;
  private readonly titleClaims = new Map<string, string>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private assertOpen(): void {
    if (this.closed) throw new Error("Thread repository is closed");
  }

  private copy(row: Omit<ThreadRecord, "title"> & { title: string | null }): ThreadRecord {
    return {
      ...row,
      scheduled: row.scheduled ? { ...row.scheduled } : null,
      title: row.title ?? "New conversation",
    };
  }

  async init(): Promise<void> {
    this.assertOpen();
  }

  async create(id: string, scheduled?: ScheduledThread): Promise<ThreadRecord> {
    this.assertOpen();
    if (this.rows.has(id)) throw new Error(`Thread already exists: ${id}`);
    const now = this.clock().toISOString();
    const row = {
      source: scheduled ? ("scheduled" as const) : ("chat" as const),
      scheduled: scheduled ? { ...scheduled } : null,
      id,
      title: null,
      createdAt: now,
      updatedAt: now,
      deleting: false,
    };
    this.rows.set(id, row);
    return this.copy(row);
  }

  async get(id: string): Promise<ThreadRecord | null> {
    this.assertOpen();
    const row = this.rows.get(id);
    return row ? this.copy(row) : null;
  }

  async list({ limit, cursor }: ListOptions): Promise<ThreadPage> {
    this.assertOpen();
    checkLimit(limit);
    const cursorTime = cursor ? new Date(cursor.updatedAt).toISOString() : undefined;
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          !row.deleting &&
          (!cursor ||
            row.updatedAt < cursorTime! ||
            (row.updatedAt === cursorTime &&
              Buffer.compare(Buffer.from(row.id), Buffer.from(cursor.id)) < 0)),
      )
      .sort((a, b) =>
        a.updatedAt === b.updatedAt
          ? Buffer.compare(Buffer.from(b.id), Buffer.from(a.id))
          : a.updatedAt > b.updatedAt
            ? -1
            : 1,
      );
    return {
      items: rows.slice(0, limit).map((row) => this.copy(row)),
      hasMore: rows.length > limit,
    };
  }

  async touch(id: string, message?: string): Promise<void> {
    this.assertOpen();
    const row = this.rows.get(id);
    if (!row || row.deleting) return;
    row.updatedAt = this.clock().toISOString();
    if (row.title === null && message !== undefined) row.title = firstTitle(message);
  }

  async startMessage(id: string, message: string): Promise<string | null> {
    this.assertOpen();
    const row = this.rows.get(id);
    if (!row || row.deleting) return null;
    row.updatedAt = this.clock().toISOString();
    if (row.title !== null) return null;
    row.title = firstTitle(message);
    const claim = randomUUID();
    this.titleClaims.set(id, claim);
    return claim;
  }

  /** Synchronous mutation lets the memory journal commit the title and event together. */
  completeTitle(id: string, claim: string, title: string): boolean {
    this.assertOpen();
    const row = this.rows.get(id);
    if (!row || row.deleting || this.titleClaims.get(id) !== claim) return false;
    row.title = title;
    this.titleClaims.delete(id);
    return true;
  }

  async markDeleting(id: string): Promise<void> {
    this.assertOpen();
    const row = this.rows.get(id);
    if (row) row.deleting = true;
  }

  async delete(id: string): Promise<void> {
    this.assertOpen();
    this.rows.delete(id);
    this.titleClaims.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
