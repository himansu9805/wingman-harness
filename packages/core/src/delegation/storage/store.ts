import {
  newPlan,
  mutatePlan,
  finishedPlan,
  type PlanRecord,
  type PlanClaim,
  type PlanMutation,
} from "../plan";
import { randomUUID } from "node:crypto";
import {
  DelegatedTaskSchema,
  type DelegatedTask,
  type DelegationIdentity,
  type DelegationRequest,
} from "../contracts";
export interface TaskClaim extends DelegationIdentity {
  parentAgentId: string;
  schedulerThreadId?: string | null;
  request: DelegationRequest;
  requestHash: string;
}
export type TaskMutation = (task: DelegatedTask) => DelegatedTask;

/** Atomic mutations run synchronously under a per-task lock, without external I/O. */
export interface DelegationStore {
  init(): Promise<void>;
  claimPlan(input: PlanClaim): Promise<{ created: boolean; plan: PlanRecord }>;
  getPlan(planId: string): Promise<PlanRecord>;
  updatePlan(planId: string, mutation: PlanMutation): Promise<PlanRecord>;
  listPlans(conversationId: string, unfinished?: boolean): Promise<PlanRecord[]>;
  deletePlan(planId: string): Promise<void>;
  listPlanTasks(planId: string): Promise<DelegatedTask[]>;
  claim(input: TaskClaim): Promise<{ created: boolean; task: DelegatedTask }>;
  get(taskId: string): Promise<DelegatedTask>;
  update(taskId: string, mutation: TaskMutation): Promise<DelegatedTask>;
  listConversation(conversationId: string): Promise<DelegatedTask[]>;
  listUnfinished(conversationId: string): Promise<DelegatedTask[]>;
  delete(taskId: string): Promise<void>;
  close(): Promise<void>;
}
export function newTask(input: TaskClaim): DelegatedTask {
  const taskId = randomUUID();
  return DelegatedTaskSchema.parse({
    ...input,
    planId: input.planId ?? null,
    planTaskKey: input.planTaskKey ?? null,
    schedulerThreadId: input.schedulerThreadId ?? null,
    taskId,
    checkpointThreadId: `wingman-delegation:${taskId}`,
    status: "running",
    output: null,
    truncated: false,
    error: null,
    version: 0,
    attempt: 0,
    ownerToken: null,
    leaseExpiresAt: null,
    fingerprint: null,
    attemptStartedAt: null,
    pausedAt: null,
    processingMs: 0,
    approvalWaitMs: 0,
    modelCalls: 0,
    pendingApprovals: [],
    approvalRounds: [],
    usage: [],
    tools: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
}
export const terminal = (task: DelegatedTask) =>
  ["completed", "failed", "interrupted", "cancelled", "recovery_required"].includes(task.status);

/** Applies immutable identity and terminal-state rules equally in memory and Postgres. */
export function mutateTask(current: DelegatedTask, mutation: TaskMutation): DelegatedTask {
  const next = mutation(structuredClone(current));
  for (const key of [
    "planId",
    "planTaskKey",
    "schedulerThreadId",
    "parentAgentId",
    "taskId",
    "conversationId",
    "parentExecutionId",
    "parentToolCallId",
    "checkpointThreadId",
    "requestHash",
    "request",
    "startedAt",
  ] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key]))
      throw new Error("Task mutation changed immutable identity");
  }
  if (
    terminal(current) &&
    !(current.status === "recovery_required" && next.status === "cancelled") &&
    JSON.stringify(next) !== JSON.stringify(current)
  )
    throw new Error("Terminal task results are immutable");
  return DelegatedTaskSchema.parse({ ...next, version: current.version + 1 });
}
export class MemoryDelegationStore implements DelegationStore {
  private readonly tasks = new Map<string, DelegatedTask>();
  private readonly plans = new Map<string, PlanRecord>();
  private closed = false;
  private assertOpen() {
    if (this.closed) throw new Error("Delegation store is closed");
  }
  async init() {
    this.assertOpen();
  }
  async claim(input: TaskClaim) {
    this.assertOpen();
    const existing = [...this.tasks.values()].find(
      (task) =>
        task.conversationId === input.conversationId &&
        task.parentExecutionId === input.parentExecutionId &&
        task.planTaskKey === (input.planTaskKey ?? null),
    );
    if (existing) return { created: false, task: structuredClone(existing) };
    const task = newTask(input);
    this.tasks.set(task.taskId, task);
    return { created: true, task: structuredClone(task) };
  }
  async claimPlan(input: PlanClaim) {
    this.assertOpen();
    const existing = [...this.plans.values()].find(
      (plan) =>
        plan.conversationId === input.conversationId &&
        plan.parentExecutionId === input.parentExecutionId,
    );
    if (existing) return { created: false, plan: structuredClone(existing) };
    const plan = newPlan(input);
    this.plans.set(plan.planId, plan);
    return { created: true, plan: structuredClone(plan) };
  }
  async getPlan(planId: string) {
    this.assertOpen();
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("Delegation plan is missing");
    return structuredClone(plan);
  }
  async updatePlan(planId: string, mutation: PlanMutation) {
    this.assertOpen();
    const latest = this.plans.get(planId);
    if (!latest) throw new Error("Delegation plan is missing");
    const plan = mutatePlan(latest, mutation);
    this.plans.set(planId, plan);
    return structuredClone(plan);
  }
  async listPlans(conversationId: string, unfinished = false) {
    this.assertOpen();
    return [...this.plans.values()]
      .filter(
        (plan) => plan.conversationId === conversationId && (!unfinished || !finishedPlan(plan)),
      )
      .slice(0, 100)
      .map((plan) => structuredClone(plan));
  }
  async deletePlan(planId: string) {
    this.assertOpen();
    this.plans.delete(planId);
  }
  async listPlanTasks(planId: string) {
    this.assertOpen();
    return [...this.tasks.values()]
      .filter((task) => task.planId === planId)
      .map((task) => structuredClone(task));
  }
  async get(taskId: string) {
    this.assertOpen();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Delegated task is missing");
    return structuredClone(task);
  }
  async update(taskId: string, mutation: TaskMutation) {
    this.assertOpen();
    const current = this.tasks.get(taskId);
    if (!current) throw new Error("Delegated task is missing");
    const task = mutateTask(current, mutation);
    this.tasks.set(taskId, task);
    return structuredClone(task);
  }
  async listConversation(conversationId: string) {
    this.assertOpen();
    return [...this.tasks.values()]
      .filter((task) => task.conversationId === conversationId)
      .slice(0, 100)
      .map((task) => structuredClone(task));
  }
  async listUnfinished(conversationId: string) {
    this.assertOpen();
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.conversationId === conversationId &&
          !["completed", "failed", "interrupted", "cancelled"].includes(task.status),
      )
      .slice(0, 100)
      .map((task) => structuredClone(task));
  }
  async delete(taskId: string) {
    this.assertOpen();
    this.tasks.delete(taskId);
  }
  async close() {
    this.closed = true;
  }
}
