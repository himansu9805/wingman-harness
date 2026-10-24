import type { Pool } from "pg";
import type { ThreadRepository } from "./thread.repository";
import type { PendingApproval, TurnEvent } from "@wingman/core/turns";

export type ThreadEventPayload =
  | TurnEvent
  | { type: "approval"; approvals: PendingApproval[] }
  | { type: "done"; text: string }
  | { type: "error"; message: string }
  | { type: "scheduled"; jobId: string; prompt: string };

export interface StoredThreadEvent {
  threadId: string;
  sequence: string;
  runId: string;
  createdAt: string;
  payload: ThreadEventPayload;
}

export const THREAD_EVENTS = Symbol("THREAD_EVENTS");

export interface ThreadEventsRepository {
  init(): Promise<void>;

  append(
    threadId: string,
    runId: string,
    payload: ThreadEventPayload,
  ): Promise<StoredThreadEvent>;

  listAfter(
    threadId: string,
    sequence: string,
    limit: number,
  ): Promise<StoredThreadEvent[]>;

  latest(threadId: string): Promise<string>;

  delete(threadId: string): Promise<void>;

  close(): Promise<void>;
}

export function validateSequence(sequence: string): void {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)
    throw new RangeError("Invalid event sequence");
}

function validatePage(sequence: string, limit: number): void {
  validateSequence(sequence);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Event limit must be between 1 and 100");
}

type EventRow = { thread_id: string; sequence: string; run_id: string; payload: ThreadEventPayload; created_at: Date };
const eventRecord = (row: EventRow): StoredThreadEvent => ({ threadId: row.thread_id, sequence: row.sequence, runId: row.run_id, payload: row.payload, createdAt: row.created_at.toISOString() });

export class PostgresThreadEventsRepository implements ThreadEventsRepository {
  private poolPromise?: Promise<Pool>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly connectionString: string) {
    if (!connectionString.trim()) throw new Error("Postgres connection string is required");
  }
  private pool(): Promise<Pool> {
    if (this.closed) return Promise.reject(new Error("Event repository is closed"));
    return this.poolPromise ??= import("pg").then(({ Pool }) => new Pool({ connectionString: this.connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 }));
  }
  async init(): Promise<void> {
    const pool = await this.pool();
    await pool.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS event_sequence BIGINT NOT NULL DEFAULT 0`);
    await pool.query(`CREATE TABLE IF NOT EXISTS thread_events (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sequence BIGINT NOT NULL, run_id UUID NOT NULL, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (thread_id, sequence))`);
  }
  async append(threadId: string, runId: string, payload: ThreadEventPayload): Promise<StoredThreadEvent> {
    const result = await (await this.pool()).query<EventRow>(`WITH next_event AS (
      UPDATE threads SET event_sequence = event_sequence + 1 WHERE id = $1 AND deleting = false RETURNING event_sequence
    ) INSERT INTO thread_events (thread_id, sequence, run_id, payload)
      SELECT $1, event_sequence, $2::uuid, $3::jsonb FROM next_event RETURNING *`, [threadId, runId, JSON.stringify(payload)]);
    if (!result.rows[0]) throw new Error("Thread is missing or deleting");
    return eventRecord(result.rows[0]);
  }
  async listAfter(threadId: string, sequence: string, limit: number): Promise<StoredThreadEvent[]> {
    validatePage(sequence, limit);
    const result = await (await this.pool()).query<EventRow>(`SELECT * FROM thread_events WHERE thread_id = $1 AND sequence > $2::bigint ORDER BY sequence LIMIT $3`, [threadId, sequence, limit]);
    return result.rows.map(eventRecord);
  }
  async latest(threadId: string): Promise<string> {
    const result = await (await this.pool()).query<{ event_sequence: string }>(`SELECT event_sequence FROM threads WHERE id=$1`, [threadId]);
    return result.rows[0]?.event_sequence ?? "0";
  }
  async delete(threadId: string): Promise<void> {
    await (await this.pool()).query(`DELETE FROM thread_events WHERE thread_id=$1`, [threadId]);
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => { if (this.poolPromise) await (await this.poolPromise).end(); })();
  }
}

export class MemoryThreadEventsRepository implements ThreadEventsRepository {
  private readonly rows = new Map<string, StoredThreadEvent[]>();
  private readonly sequences = new Map<string, bigint>();
  private closed = false;
  constructor(private readonly threads: ThreadRepository) {}
  private assertOpen() { if (this.closed) throw new Error("Event repository is closed"); }
  async init(): Promise<void> { this.assertOpen(); }
  async append(threadId: string, runId: string, payload: ThreadEventPayload): Promise<StoredThreadEvent> {
    this.assertOpen();
    const thread = await this.threads.get(threadId);
    if (!thread || thread.deleting) throw new Error("Thread is missing or deleting");
    const sequence = (this.sequences.get(threadId) ?? 0n) + 1n;
    this.sequences.set(threadId, sequence);
    const record = { threadId, runId, sequence: String(sequence), payload: structuredClone(payload), createdAt: new Date().toISOString() };
    const rows = this.rows.get(threadId) ?? [];
    rows.push(record); this.rows.set(threadId, rows);
    return structuredClone(record);
  }
  async listAfter(threadId: string, sequence: string, limit: number): Promise<StoredThreadEvent[]> {
    this.assertOpen(); validatePage(sequence, limit);
    return structuredClone((this.rows.get(threadId) ?? []).filter(row => BigInt(row.sequence) > BigInt(sequence)).slice(0, limit));
  }
  async latest(threadId: string): Promise<string> { this.assertOpen(); return String(this.sequences.get(threadId) ?? 0n); }
  async delete(threadId: string): Promise<void> { this.assertOpen(); this.rows.delete(threadId); }
  async close(): Promise<void> { this.closed = true; }
}
