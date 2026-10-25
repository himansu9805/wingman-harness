import pg from "pg";
import { settings } from "../settings";
import { TaskRun } from "./interfaces";

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

/**
 * Creates the `task_runs` table if it doesn't exist, and returns a connected pool.
 *
 * @returns A connected Postgres pool.
 */
async function getPool(): Promise<pg.Pool> {
  pool ??= new pg.Pool({
    connectionString: settings.POSTGRES_CONNECTION_STRING,
    connectionTimeoutMillis: 5000, query_timeout: 10000,
  });
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS task_runs (
       id          BIGSERIAL PRIMARY KEY,
       job_id      TEXT NOT NULL,
       prompt      TEXT NOT NULL,
       thread_id   TEXT NOT NULL,
       status      TEXT NOT NULL,
       output      TEXT,
       error       TEXT,
       started_at  TIMESTAMPTZ NOT NULL,
       finished_at TIMESTAMPTZ NOT NULL
     );
     CREATE INDEX IF NOT EXISTS task_runs_job_id_idx
       ON task_runs (job_id, started_at DESC);
     CREATE INDEX IF NOT EXISTS task_runs_job_page_idx ON task_runs (job_id, id DESC);`,
    )
    .then(() => {});
  return ready.then(() => pool!);
}

/**
 * Records a task run in the database.
 *
 * @param run The task run to record.
 */
export async function recordRun(run: TaskRun): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO task_runs
       (job_id, prompt, thread_id, status, output, error, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      run.jobId,
      run.prompt,
      run.threadId,
      run.status,
      run.output ?? null,
      run.error ?? null,
      run.startedAt,
      run.finishedAt,
    ],
  );
}

/**
 * Returns the most recent task runs, optionally filtered by job ID.
 *
 * @param jobId If provided, only returns runs for this job.
 * @param limit The maximum number of runs to return.
 * @returns An array of task runs, ordered by most recent first.
 */
export async function getRecentRuns(jobId?: string, limit = 10) {
  const db = await getPool();
  const { rows } = await db.query(
    `SELECT * FROM task_runs
     WHERE ($1::text IS NULL OR job_id = $1)
     ORDER BY started_at DESC LIMIT $2`,
    [jobId ?? null, limit],
  );
  return rows;
}

/* Closes the database connection and cleans up resources. */
export async function closeResults(): Promise<void> {
  await pool?.end();
  pool = null;
  ready = null;
}


/** Bounded execution history remains readable after the schedule is cancelled. */
export async function getTaskRunPage(limit: number, jobId?: string, before?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid run page limit");
  const db = await getPool();
  const { rows } = await db.query(`SELECT id::text, job_id, left(prompt,20000) AS prompt, thread_id, status,
    left(output,16000) AS output, left(error,2000) AS error,
    (length(output)>16000 OR length(error)>2000) IS TRUE AS truncated, started_at, finished_at
    FROM task_runs WHERE ($1::text IS NULL OR job_id=$1) AND ($2::bigint IS NULL OR id<$2::bigint)
    ORDER BY id DESC LIMIT $3`, [jobId ?? null, before ?? null, limit + 1]);
  const items = rows.slice(0, limit).map(row => ({ id: row.id as string, jobId: row.job_id as string,
    prompt: row.prompt as string, threadId: row.thread_id as string, status: row.status as TaskRun["status"],
    output: row.output as string | null, error: row.error as string | null, truncated: row.truncated as boolean,
    startedAt: row.started_at.toISOString() as string, finishedAt: row.finished_at.toISOString() as string }));
  return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
}
