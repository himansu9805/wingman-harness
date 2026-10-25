import type { Pool } from "pg";
import { computeJobState } from "agenda";

interface TaskRow {
  id: string; prompt: string | null; thread_id: string | null; disabled: boolean;
  next_run_at: Date | null; repeat_interval: string | null; locked_at: Date | null;
  last_finished_at: Date | null; failed_at: Date | null;
}

export class TaskBusyError extends Error {
  constructor() { super("Task is locked or running; retry cancellation after execution finishes."); this.name = "TaskBusyError"; }
}

/** Reads Agenda's existing table; there is no separate task catalogue. */
export async function taskPage(db: Pool, limit: number, before?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid task page limit");
  const { rows } = await db.query<TaskRow>(`SELECT id, left(data->>'prompt', 20000) AS prompt,
    data->>'threadId' AS thread_id, next_run_at, repeat_interval, locked_at,
    last_finished_at, failed_at, disabled FROM agenda_jobs
    WHERE name='agent-task' AND ($1::uuid IS NULL OR id < $1::uuid)
    ORDER BY id DESC LIMIT $2`, [before ?? null, limit + 1]);
  const items = rows.slice(0, limit).map(row => ({
    id: row.id as string, prompt: (row.prompt ?? "") as string, threadId: (row.thread_id ?? null) as string | null,
    nextRunAt: row.next_run_at?.toISOString() ?? null, repeatInterval: row.repeat_interval ?? null,
    state: row.locked_at ? "running" : row.disabled ? "paused" : computeJobState({ name: "agent-task", priority: 0, type: "normal", data: {}, lockedAt: row.locked_at ?? undefined,
      nextRunAt: row.next_run_at, repeatInterval: row.repeat_interval ?? undefined,
      lastFinishedAt: row.last_finished_at ?? undefined, failedAt: row.failed_at ?? undefined }),
  }));
  return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
}

/** Atomic with Agenda's lock acquisition; never deletes a locked job. */
export async function cancelUnlockedTask(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM agenda_jobs WHERE id=$1::uuid AND name='agent-task'
    AND locked_at IS NULL RETURNING id`, [id]);
  if (result.rowCount) return true;
  const existing = await db.query(`SELECT id FROM agenda_jobs WHERE id=$1::uuid AND name='agent-task'`, [id]);
  if (existing.rowCount) throw new TaskBusyError();
  return false;
}
