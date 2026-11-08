import pg from "pg";
import { DelegatedTaskSchema } from "./types";
import {
  newTask,
  mutateTask,
  type DelegationStore,
  type TaskClaim,
  type TaskMutation,
} from "./store";

/** One runtime-owned pool; row locks fence concurrent resumes and tool completion. */
export class PostgresDelegationStore implements DelegationStore {
  private readonly pool: pg.Pool;
  private closing?: Promise<void>;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS delegated_tasks (
      id UUID PRIMARY KEY, conversation_id TEXT NOT NULL, parent_execution_id TEXT NOT NULL,
      data JSONB NOT NULL, UNIQUE (conversation_id, parent_execution_id))`);
    // One-time normalization of the preceding pre-release schema. Unknown running
    // executions must not become fresh, automatically retryable attempts.
    await this.pool.query(`UPDATE delegated_tasks SET data = data || jsonb_build_object(
      'parentAgentId', 'default', 'schedulerThreadId', NULL, 'version', 0, 'attempt', 1, 'ownerToken', NULL, 'leaseExpiresAt', NULL, 'fingerprint', NULL,
      'attemptStartedAt', NULL, 'pausedAt', NULL, 'processingMs', 0, 'approvalWaitMs', 0,
      'modelCalls', jsonb_array_length(data->'usage'), 'pendingApprovals', '[]'::jsonb,
      'approvalRounds', '[]'::jsonb, 'tools', '[]'::jsonb,
      'usage', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', 'migrated-' || n, 'usage', u))
        FROM jsonb_array_elements(data->'usage') WITH ORDINALITY AS x(u,n)), '[]'::jsonb),
      'status', CASE WHEN data->>'status'='running' THEN 'recovery_required' ELSE data->>'status' END,
      'error', CASE WHEN data->>'status'='running' THEN 'Previous execution outcome is uncertain' ELSE data->>'error' END
    ) WHERE NOT (data ? 'version')`);
  }
  async claim(input: TaskClaim) {
    const task = newTask(input);
    const inserted = await this.pool.query(
      `INSERT INTO delegated_tasks (id, conversation_id, parent_execution_id, data)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (conversation_id,parent_execution_id) DO NOTHING RETURNING data`,
      [task.taskId, task.conversationId, task.parentExecutionId, JSON.stringify(task)],
    );
    if (inserted.rows[0])
      return { created: true, task: DelegatedTaskSchema.parse(inserted.rows[0].data) };
    const existing = await this.pool.query(
      `SELECT data FROM delegated_tasks WHERE conversation_id=$1 AND parent_execution_id=$2`,
      [input.conversationId, input.parentExecutionId],
    );
    if (!existing.rows[0]) throw new Error("Delegated task disappeared during claim");
    return { created: false, task: DelegatedTaskSchema.parse(existing.rows[0].data) };
  }
  async get(taskId: string) {
    const result = await this.pool.query(`SELECT data FROM delegated_tasks WHERE id=$1`, [taskId]);
    if (!result.rows[0]) throw new Error("Delegated task is missing");
    return DelegatedTaskSchema.parse(result.rows[0].data);
  }
  async update(taskId: string, mutation: TaskMutation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query(`SELECT data FROM delegated_tasks WHERE id=$1 FOR UPDATE`, [
        taskId,
      ]);
      if (!row.rows[0]) throw new Error("Delegated task is missing");
      const next = mutateTask(DelegatedTaskSchema.parse(row.rows[0].data), mutation);
      await client.query(`UPDATE delegated_tasks SET data=$2::jsonb WHERE id=$1`, [
        taskId,
        JSON.stringify(next),
      ]);
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async listConversation(conversationId: string) {
    const result = await this.pool.query(
      `SELECT data FROM delegated_tasks WHERE conversation_id=$1 ORDER BY id LIMIT 100`,
      [conversationId],
    );
    return result.rows.map((row) => DelegatedTaskSchema.parse(row.data));
  }
  async listUnfinished(conversationId: string) {
    const result = await this.pool.query(
      `SELECT data FROM delegated_tasks WHERE conversation_id=$1
      AND data->>'status' NOT IN ('completed','failed','interrupted','cancelled') ORDER BY id LIMIT 100`,
      [conversationId],
    );
    return result.rows.map((row) => DelegatedTaskSchema.parse(row.data));
  }
  async delete(taskId: string) {
    await this.pool.query(`DELETE FROM delegated_tasks WHERE id=$1`, [taskId]);
  }
  close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}
