import { PlanRecordSchema, newPlan, mutatePlan, type PlanClaim, type PlanMutation } from "../plan";
import pg from "pg";
import { DelegatedTaskSchema } from "../contracts";
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
    await this.pool.query(
      `UPDATE delegated_tasks SET data = data || '{"planId":null,"planTaskKey":null}'::jsonb WHERE NOT (data ? 'planId')`,
    );
    const migration = await this.pool.connect();
    try {
      await migration.query("BEGIN");
      await migration.query(`CREATE UNIQUE INDEX IF NOT EXISTS delegated_task_slot ON delegated_tasks
        (conversation_id,parent_execution_id,(COALESCE(data->>'planTaskKey','')))`);
      await migration.query(
        `ALTER TABLE delegated_tasks DROP CONSTRAINT IF EXISTS delegated_tasks_conversation_id_parent_execution_id_key`,
      );
      await migration.query(`CREATE TABLE IF NOT EXISTS delegated_plans (
        id UUID PRIMARY KEY, conversation_id TEXT NOT NULL, parent_execution_id TEXT NOT NULL,
        data JSONB NOT NULL, UNIQUE(conversation_id,parent_execution_id))`);
      await migration.query(
        `CREATE INDEX IF NOT EXISTS delegated_task_plan ON delegated_tasks ((data->>'planId')) WHERE data->>'planId' IS NOT NULL`,
      );
      await migration.query("COMMIT");
    } catch (error) {
      await migration.query("ROLLBACK");
      throw error;
    } finally {
      migration.release();
    }
  }
  async claim(input: TaskClaim) {
    const task = newTask(input);
    const inserted = await this.pool.query(
      `INSERT INTO delegated_tasks (id, conversation_id, parent_execution_id, data)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`,
      [task.taskId, task.conversationId, task.parentExecutionId, JSON.stringify(task)],
    );
    if (inserted.rows[0])
      return { created: true, task: DelegatedTaskSchema.parse(inserted.rows[0].data) };
    const existing = await this.pool.query(
      `SELECT data FROM delegated_tasks WHERE conversation_id=$1 AND parent_execution_id=$2 AND COALESCE(data->>'planTaskKey','')=$3`,
      [input.conversationId, input.parentExecutionId, input.planTaskKey ?? ""],
    );
    if (!existing.rows[0]) throw new Error("Delegated task disappeared during claim");
    return { created: false, task: DelegatedTaskSchema.parse(existing.rows[0].data) };
  }
  async claimPlan(input: PlanClaim) {
    const plan = newPlan(input);
    const inserted = await this.pool.query(
      `INSERT INTO delegated_plans (id,conversation_id,parent_execution_id,data)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`,
      [plan.planId, plan.conversationId, plan.parentExecutionId, JSON.stringify(plan)],
    );
    if (inserted.rows[0])
      return { created: true, plan: PlanRecordSchema.parse(inserted.rows[0].data) };
    const existing = await this.pool.query(
      `SELECT data FROM delegated_plans WHERE conversation_id=$1 AND parent_execution_id=$2`,
      [input.conversationId, input.parentExecutionId],
    );
    if (!existing.rows[0]) throw new Error("Delegation plan disappeared during claim");
    return { created: false, plan: PlanRecordSchema.parse(existing.rows[0].data) };
  }
  async getPlan(planId: string) {
    const result = await this.pool.query(`SELECT data FROM delegated_plans WHERE id=$1`, [planId]);
    if (!result.rows[0]) throw new Error("Delegation plan is missing");
    return PlanRecordSchema.parse(result.rows[0].data);
  }
  async updatePlan(planId: string, mutation: PlanMutation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query(`SELECT data FROM delegated_plans WHERE id=$1 FOR UPDATE`, [
        planId,
      ]);
      if (!row.rows[0]) throw new Error("Delegation plan is missing");
      const next = mutatePlan(PlanRecordSchema.parse(row.rows[0].data), mutation);
      await client.query(`UPDATE delegated_plans SET data=$2::jsonb WHERE id=$1`, [
        planId,
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
  async listPlans(conversationId: string, unfinished = false) {
    const result = await this.pool.query(
      `SELECT data FROM delegated_plans WHERE conversation_id=$1 AND ($2=false OR data->>'status' IN ('running','waiting_approval','cancelling')) ORDER BY id LIMIT 100`,
      [conversationId, unfinished],
    );
    return result.rows.map((row) => PlanRecordSchema.parse(row.data));
  }
  async deletePlan(planId: string) {
    await this.pool.query(`DELETE FROM delegated_plans WHERE id=$1`, [planId]);
  }
  async listPlanTasks(planId: string) {
    const result = await this.pool.query(
      `SELECT data FROM delegated_tasks WHERE data->>'planId'=$1 ORDER BY id LIMIT 8`,
      [planId],
    );
    return result.rows.map((row) => DelegatedTaskSchema.parse(row.data));
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
