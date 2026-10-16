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
       ON task_runs (job_id, started_at DESC);`,
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
