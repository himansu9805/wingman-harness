import pg from "pg";
import { DelegatedTaskSchema, type TaskFinish } from "./types";
import { newTask, type DelegationStore, type TaskClaim } from "./store";
import type { ModelUsage } from "../usage";

/** Runtime-owned pool; workers borrow the store and never initialize their own pool. */
export class PostgresDelegationStore implements DelegationStore {
  private readonly pool: pg.Pool;
  private closing?: Promise<void>;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS delegated_tasks (
      id UUID PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_execution_id TEXT NOT NULL,
      data JSONB NOT NULL,
      UNIQUE (conversation_id, parent_execution_id)
    )`);
  }
  async claim(input: TaskClaim) {
    const task = newTask(input);
    const inserted = await this.pool.query(`INSERT INTO delegated_tasks (id, conversation_id, parent_execution_id, data)
      VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (conversation_id, parent_execution_id) DO NOTHING RETURNING data`,
    [task.taskId, task.conversationId, task.parentExecutionId, JSON.stringify(task)]);
    if (inserted.rows[0]) return { created: true, task: DelegatedTaskSchema.parse(inserted.rows[0].data) };
    const existing = await this.pool.query(`SELECT data FROM delegated_tasks WHERE conversation_id=$1 AND parent_execution_id=$2`, [input.conversationId, input.parentExecutionId]);
    if (!existing.rows[0]) throw new Error("Delegated task disappeared during claim");
    return { created: false, task: DelegatedTaskSchema.parse(existing.rows[0].data) };
  }
  async recordUsage(taskId: string, usage: ModelUsage) {
    const updated = await this.pool.query(`UPDATE delegated_tasks SET data=jsonb_set(data, '{usage}', (data->'usage') || $2::jsonb)
      WHERE id=$1 AND data->>'status'='running' AND jsonb_array_length(data->'usage') < 1 RETURNING id`, [taskId, JSON.stringify([usage])]);
    if (!updated.rowCount) throw new Error("Delegated model-call budget exhausted");
  }
  async finish(taskId: string, result: TaskFinish) {
    const updated = await this.pool.query(`UPDATE delegated_tasks SET data=data || $2::jsonb
      WHERE id=$1 AND data->>'status'='running' RETURNING data`, [taskId, JSON.stringify(result)]);
    if (updated.rows[0]) return DelegatedTaskSchema.parse(updated.rows[0].data);
    const existing = await this.pool.query(`SELECT data FROM delegated_tasks WHERE id=$1`, [taskId]);
    if (!existing.rows[0]) throw new Error("Delegated task is missing");
    return DelegatedTaskSchema.parse(existing.rows[0].data);
  }
  async listConversation(conversationId: string) {
    const result = await this.pool.query(`SELECT data FROM delegated_tasks WHERE conversation_id=$1 ORDER BY id LIMIT 100`, [conversationId]);
    return result.rows.map(row => DelegatedTaskSchema.parse(row.data));
  }
  async delete(taskId: string) { await this.pool.query(`DELETE FROM delegated_tasks WHERE id=$1`, [taskId]); }
  close(): Promise<void> { return this.closing ??= this.pool.end(); }
}
