import type { RunMetadata } from "../agent/run-metadata";
import type { Pool } from "pg";
import type { MemoryThreadRepository } from "./thread.repository";
import type { PendingApproval, TurnEvent } from "@wingman/core/turns";

export type ThreadEventPayload =
  | { type: "thread_title"; title: string }
  | { type: "run"; metadata: RunMetadata }
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

export interface SnapshotSelection {
  messageIds: string[];
  callIds: string[];
  replies: { reply: string; take: number; skip: number }[];
  latest: boolean;
}

export const THREAD_EVENTS = Symbol("THREAD_EVENTS");

export interface ThreadEventsRepository {
  init(): Promise<void>;

  append(threadId: string, runId: string, payload: ThreadEventPayload): Promise<StoredThreadEvent>;

  /** Atomically replace a claimed fallback and publish its durable title event. */
  completeTitle(threadId: string, claimId: string, runId: string, title: string): Promise<boolean>;

  listAfter(threadId: string, sequence: string, limit: number): Promise<StoredThreadEvent[]>;

  latest(threadId: string): Promise<string>;

  /** Read page activity through an inclusive journal watermark. */
  snapshot(
    threadId: string,
    through: string,
    selection: SnapshotSelection,
  ): Promise<StoredThreadEvent[]>;

  listRuns(
    threadId: string,
    before: string | undefined,
    limit: number,
  ): Promise<StoredThreadEvent[]>;

  /** Return the latest durable run status for each requested thread. */
  latestStatuses(threadIds: string[]): Promise<Map<string, RunMetadata["status"]>>;

  delete(threadId: string): Promise<void>;

  close(): Promise<void>;
}

export function validateSequence(sequence: string): void {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)
    throw new RangeError("Invalid event sequence");
}

function validatePage(sequence: string, limit: number): void {
  validateSequence(sequence);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Event limit must be between 1 and 100");
}

type EventRow = {
  thread_id: string;
  sequence: string;
  run_id: string;
  payload: ThreadEventPayload;
  created_at: Date;
};
const eventRecord = (row: EventRow): StoredThreadEvent => ({
  threadId: row.thread_id,
  sequence: row.sequence,
  runId: row.run_id,
  payload: row.payload,
  createdAt: row.created_at.toISOString(),
});

export class PostgresThreadEventsRepository implements ThreadEventsRepository {
  private poolPromise?: Promise<Pool>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly connectionString: string) {
    if (!connectionString.trim()) throw new Error("Postgres connection string is required");
  }
  private pool(): Promise<Pool> {
    if (this.closed) return Promise.reject(new Error("Event repository is closed"));
    return (this.poolPromise ??= import("pg").then(
      ({ Pool }) =>
        new Pool({
          connectionString: this.connectionString,
          connectionTimeoutMillis: 5000,
          query_timeout: 10000,
        }),
    ));
  }
  async init(): Promise<void> {
    const pool = await this.pool();
    await pool.query(
      `ALTER TABLE threads ADD COLUMN IF NOT EXISTS event_sequence BIGINT NOT NULL DEFAULT 0`,
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS thread_events (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sequence BIGINT NOT NULL, run_id UUID NOT NULL, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (thread_id, sequence))`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS thread_events_runs_idx ON thread_events (thread_id, run_id, sequence DESC) WHERE payload->>'type'='run'`,
    );
    // Index the stable turn ID and legacy history anchors used to select page runs.
    for (const [name, expression, predicate] of [
      ["turn", "(payload->'metadata'->>'turnId')", "payload->>'type'='run'"],
      ["owner", "(payload->>'parentExecutionId')", "payload->>'type'='delegation_plan'"],
      ["call", "(payload->>'toolCallId')", "payload ? 'toolCallId'"],
      ["reply", "md5(payload->>'text')", "payload->>'type'='done'"],
    ]) {
      await pool.query(`CREATE INDEX IF NOT EXISTS thread_events_snapshot_${name}_idx
        ON thread_events (thread_id, ${expression}, sequence DESC) WHERE ${predicate}`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS thread_events_title_idx
      ON thread_events (thread_id, sequence DESC) WHERE payload->>'type'='thread_title'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS thread_events_snapshot_run_idx
      ON thread_events (thread_id, run_id, sequence DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS thread_events_latest_status_idx
      ON thread_events (thread_id, sequence DESC) WHERE payload->>'type'='run'`);
  }
  async append(
    threadId: string,
    runId: string,
    payload: ThreadEventPayload,
  ): Promise<StoredThreadEvent> {
    const result = await (
      await this.pool()
    ).query<EventRow>(
      `WITH next_event AS (
      UPDATE threads SET event_sequence = event_sequence + 1 WHERE id = $1 AND deleting = false RETURNING event_sequence
    ) INSERT INTO thread_events (thread_id, sequence, run_id, payload)
      SELECT $1, event_sequence, $2::uuid, $3::jsonb FROM next_event RETURNING *`,
      [threadId, runId, JSON.stringify(payload)],
    );
    if (!result.rows[0]) throw new Error("Thread is missing or deleting");
    return eventRecord(result.rows[0]);
  }
  async completeTitle(
    threadId: string,
    claimId: string,
    runId: string,
    title: string,
  ): Promise<boolean> {
    const result = await (
      await this.pool()
    ).query(
      `WITH titled AS (
        UPDATE threads SET title = $3, title_generation_id = NULL, event_sequence = event_sequence + 1
        WHERE id = $1 AND deleting = false AND title_generation_id = $2::uuid RETURNING event_sequence
      ) INSERT INTO thread_events (thread_id, sequence, run_id, payload)
        SELECT $1, event_sequence, $4::uuid, $5::jsonb FROM titled RETURNING sequence`,
      [threadId, claimId, title, runId, JSON.stringify({ type: "thread_title", title })],
    );
    return result.rows.length > 0;
  }

  async listAfter(threadId: string, sequence: string, limit: number): Promise<StoredThreadEvent[]> {
    validatePage(sequence, limit);
    const result = await (
      await this.pool()
    ).query<EventRow>(
      `SELECT * FROM thread_events WHERE thread_id = $1 AND sequence > $2::bigint ORDER BY sequence LIMIT $3`,
      [threadId, sequence, limit],
    );
    return result.rows.map(eventRecord);
  }
  async listRuns(
    threadId: string,
    before: string | undefined,
    limit: number,
  ): Promise<StoredThreadEvent[]> {
    validatePage(before ?? "0", limit);
    const result = await (
      await this.pool()
    ).query<EventRow>(
      `SELECT * FROM (
      SELECT DISTINCT ON (run_id) * FROM thread_events WHERE thread_id=$1 AND payload->>'type'='run'
      ORDER BY run_id, sequence DESC
    ) latest WHERE ($2::bigint IS NULL OR sequence < $2::bigint) ORDER BY sequence DESC LIMIT $3`,
      [threadId, before ?? null, limit],
    );
    return result.rows.map(eventRecord);
  }
  async snapshot(
    threadId: string,
    through: string,
    selection: SnapshotSelection,
  ): Promise<StoredThreadEvent[]> {
    validateSequence(through);
    const result = await (
      await this.pool()
    ).query<EventRow>(
      `WITH anchors AS (
        SELECT run_id FROM thread_events WHERE thread_id=$1 AND sequence <= $2
          AND payload->>'type'='run' AND payload->'metadata'->>'turnId'=ANY($3::text[])
        UNION
        SELECT run_id FROM thread_events WHERE thread_id=$1 AND sequence <= $2
          AND payload->>'type'='delegation_plan' AND payload->>'parentExecutionId'=ANY($3::text[])
        UNION
        SELECT run_id FROM thread_events WHERE thread_id=$1 AND sequence <= $2
          AND payload ? 'toolCallId' AND payload->>'toolCallId'=ANY($4::text[])
        UNION
        SELECT found.run_id FROM jsonb_to_recordset($5::jsonb)
          AS replies(reply text, take integer, skip integer) CROSS JOIN LATERAL (
          SELECT run_id FROM thread_events WHERE thread_id=$1 AND sequence <= $2
            AND payload->>'type'='done' AND md5(payload->>'text')=md5(replies.reply)
            AND payload->>'text'=replies.reply ORDER BY sequence DESC LIMIT replies.take OFFSET replies.skip
        ) found
        UNION
        (SELECT run_id FROM thread_events WHERE $6::boolean AND thread_id=$1 AND sequence <= $2
          AND payload->>'type'<>'thread_title' ORDER BY sequence DESC LIMIT 1)
      ), turns AS (
        SELECT DISTINCT payload->'metadata'->>'turnId' AS id FROM thread_events
        JOIN anchors USING (run_id) WHERE thread_id=$1 AND sequence <= $2 AND payload->>'type'='run'
      ), runs AS (
        SELECT run_id FROM anchors
        UNION
        SELECT run_id FROM thread_events JOIN turns ON payload->'metadata'->>'turnId'=turns.id
          WHERE thread_id=$1 AND sequence <= $2 AND payload->>'type'='run'
      ), relevant AS (
        SELECT e.*, CASE e.payload->>'type'
          WHEN 'run' THEN e.run_id::text
          WHEN 'delegation_plan' THEN e.payload->>'planId'
        END AS snapshot_key
        FROM runs JOIN thread_events e USING (run_id)
        WHERE e.thread_id=$1 AND e.sequence <= $2 AND e.payload->>'type'<>'thread_title'
      ), ranked AS (
        SELECT relevant.*, row_number() OVER (
          PARTITION BY payload->>'type', snapshot_key ORDER BY sequence DESC
        ) AS revision FROM relevant
      )
      SELECT thread_id, sequence, run_id, payload, created_at
        FROM ranked WHERE snapshot_key IS NULL OR revision=1
      UNION ALL
      (SELECT * FROM thread_events WHERE $6::boolean AND thread_id=$1 AND sequence <= $2
        AND payload->>'type'='thread_title' ORDER BY sequence DESC LIMIT 1)
      ORDER BY sequence`,
      [
        threadId,
        through,
        selection.messageIds,
        selection.callIds,
        JSON.stringify(selection.replies),
        selection.latest,
      ],
    );
    return result.rows.map(eventRecord);
  }
  async latest(threadId: string): Promise<string> {
    const result = await (
      await this.pool()
    ).query<{ event_sequence: string }>(`SELECT event_sequence FROM threads WHERE id=$1`, [
      threadId,
    ]);
    return result.rows[0]?.event_sequence ?? "0";
  }
  async latestStatuses(threadIds: string[]): Promise<Map<string, RunMetadata["status"]>> {
    if (threadIds.length === 0) return new Map();

    const result = await (
      await this.pool()
    ).query<{
      thread_id: string;
      status: RunMetadata["status"];
    }>(
      `SELECT DISTINCT ON (thread_id)
        thread_id,
        payload->'metadata'->>'status' AS status
      FROM thread_events
      WHERE thread_id = ANY($1::text[])
        AND payload->>'type'='run'
      ORDER BY thread_id, sequence DESC`,
      [threadIds],
    );

    return new Map(result.rows.map((row) => [row.thread_id, row.status]));
  }
  async delete(threadId: string): Promise<void> {
    await (await this.pool()).query(`DELETE FROM thread_events WHERE thread_id=$1`, [threadId]);
  }
  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      if (this.poolPromise) await (await this.poolPromise).end();
    })());
  }
}

export class MemoryThreadEventsRepository implements ThreadEventsRepository {
  private readonly rows = new Map<string, StoredThreadEvent[]>();
  private readonly sequences = new Map<string, bigint>();
  private closed = false;
  constructor(private readonly threads: MemoryThreadRepository) {}
  private assertOpen() {
    if (this.closed) throw new Error("Event repository is closed");
  }
  async init(): Promise<void> {
    this.assertOpen();
  }
  async append(
    threadId: string,
    runId: string,
    payload: ThreadEventPayload,
  ): Promise<StoredThreadEvent> {
    this.assertOpen();
    const thread = await this.threads.get(threadId);
    if (!thread || thread.deleting) throw new Error("Thread is missing or deleting");
    return this.storeEvent(threadId, runId, payload);
  }

  private storeEvent(
    threadId: string,
    runId: string,
    payload: ThreadEventPayload,
  ): StoredThreadEvent {
    const sequence = (this.sequences.get(threadId) ?? 0n) + 1n;
    this.sequences.set(threadId, sequence);
    const record = {
      threadId,
      runId,
      sequence: String(sequence),
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
    };
    const rows = this.rows.get(threadId) ?? [];
    rows.push(record);
    this.rows.set(threadId, rows);
    return structuredClone(record);
  }
  async completeTitle(
    threadId: string,
    claimId: string,
    runId: string,
    title: string,
  ): Promise<boolean> {
    this.assertOpen();
    if (!this.threads.completeTitle(threadId, claimId, title)) return false;
    this.storeEvent(threadId, runId, { type: "thread_title", title });
    return true;
  }

  async listAfter(threadId: string, sequence: string, limit: number): Promise<StoredThreadEvent[]> {
    this.assertOpen();
    validatePage(sequence, limit);
    return structuredClone(
      (this.rows.get(threadId) ?? [])
        .filter((row) => BigInt(row.sequence) > BigInt(sequence))
        .slice(0, limit),
    );
  }
  async listRuns(
    threadId: string,
    before: string | undefined,
    limit: number,
  ): Promise<StoredThreadEvent[]> {
    this.assertOpen();
    validatePage(before ?? "0", limit);
    const latest = new Map<string, StoredThreadEvent>();
    for (const row of this.rows.get(threadId) ?? [])
      if (row.payload.type === "run") latest.set(row.runId, row);
    return structuredClone(
      [...latest.values()]
        .sort((a, b) => (BigInt(a.sequence) > BigInt(b.sequence) ? -1 : 1))
        .filter((row) => before === undefined || BigInt(row.sequence) < BigInt(before))
        .slice(0, limit),
    );
  }
  async snapshot(
    threadId: string,
    through: string,
    selection: SnapshotSelection,
  ): Promise<StoredThreadEvent[]> {
    this.assertOpen();
    validateSequence(through);
    const bounded = (this.rows.get(threadId) ?? [])
      .filter((row) => BigInt(row.sequence) <= BigInt(through))
      .reverse();
    const title = selection.latest
      ? bounded.find((row) => row.payload.type === "thread_title")
      : undefined;
    const rows = bounded.filter((row) => row.payload.type !== "thread_title");
    const runs = new Set<string>();
    const replies = new Map(
      selection.replies.map(({ reply, take, skip }) => [reply, { take, skip }]),
    );
    if (selection.latest && rows.length) runs.add(rows[0].runId);
    for (const { payload, runId } of rows) {
      if (
        (payload.type === "run" && selection.messageIds.includes(payload.metadata.turnId)) ||
        (payload.type === "delegation_plan" &&
          selection.messageIds.includes(payload.parentExecutionId)) ||
        ("toolCallId" in payload &&
          payload.toolCallId &&
          selection.callIds.includes(payload.toolCallId))
      )
        runs.add(runId);
      if (payload.type === "done") {
        const window = replies.get(payload.text);
        if (window?.skip) window.skip--;
        else if (window?.take) {
          runs.add(runId);
          window.take--;
        }
      }
    }
    const turns = new Set(
      rows.flatMap(({ payload, runId }) =>
        payload.type === "run" && runs.has(runId) ? [payload.metadata.turnId] : [],
      ),
    );
    for (const { payload, runId } of rows)
      if (payload.type === "run" && turns.has(payload.metadata.turnId)) runs.add(runId);
    const snapshots = new Set<string>();
    return structuredClone(
      bounded
        .filter((row) => {
          const { payload, runId } = row;
          if (payload.type === "thread_title") return row === title;
          if (!runs.has(runId)) return false;
          const key =
            payload.type === "run"
              ? `run:${runId}`
              : payload.type === "delegation_plan"
                ? `plan:${payload.planId}`
                : undefined;
          if (key === undefined) return true;
          if (snapshots.has(key)) return false;
          snapshots.add(key);
          return true;
        })
        .reverse(),
    );
  }
  async latest(threadId: string): Promise<string> {
    this.assertOpen();
    return String(this.sequences.get(threadId) ?? 0n);
  }
  async latestStatuses(threadIds: string[]): Promise<Map<string, RunMetadata["status"]>> {
    this.assertOpen();

    const statuses = new Map<string, RunMetadata["status"]>();

    for (const threadId of threadIds) {
      const rows = this.rows.get(threadId) ?? [];

      for (let index = rows.length - 1; index >= 0; index--) {
        const payload = rows[index].payload;

        if (payload.type === "run") {
          statuses.set(threadId, payload.metadata.status);
          break;
        }
      }
    }

    return statuses;
  }
  async delete(threadId: string): Promise<void> {
    this.assertOpen();
    this.rows.delete(threadId);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
