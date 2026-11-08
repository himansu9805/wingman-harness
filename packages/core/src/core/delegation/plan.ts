import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PendingApprovalSchema } from "../approvals";
import { DelegatedTaskSchema, DelegationRejected } from "./types";
import type { RegisteredAgentDefinition, AgentRegistry } from "../agents/registry";

const TaskKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const PlannedTaskSchema = z
  .object({
    key: TaskKey,
    agentId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    objective: z.string().trim().min(1).max(3000),
    context: z.string().max(4000),
    expectedResult: z.string().trim().min(1).max(500),
    dependsOn: z.array(TaskKey).max(7),
  })
  .strict();
export const DelegationPlanSchema = z
  .object({ tasks: z.array(PlannedTaskSchema).min(1).max(8) })
  .strict();
export type DelegationPlan = z.infer<typeof DelegationPlanSchema>;
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;
const PlanResultSchema = z.object({
  key: TaskKey,
  agentId: z.string(),
  taskId: z.string().uuid().nullable(),
  status: z.union([DelegatedTaskSchema.shape.status, z.literal("pending"), z.literal("blocked")]),
  output: z.string().max(4000).nullable(),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export const PlanRecordSchema = z.object({
  planId: z.string().uuid(),
  parentAgentId: z.string(),
  conversationId: z.string(),
  parentExecutionId: z.string(),
  parentToolCallId: z.string(),
  requestHash: z.string(),
  request: DelegationPlanSchema,
  schedulerThreadId: z.string().nullable(),
  status: z.enum([
    "running",
    "waiting_approval",
    "completed",
    "partial",
    "failed",
    "cancelling",
    "cancelled",
    "recovery_required",
  ]),
  version: z.number().int().nonnegative(),
  ownerToken: z.string().uuid().nullable(),
  leaseExpiresAt: z.string().nullable(),
  results: z.array(PlanResultSchema).max(8),
  approvalRounds: z
    .array(
      z.object({
        approvals: z.array(PendingApprovalSchema).min(1).max(256),
        answers: z.record(z.string(), z.boolean()).nullable(),
      }),
    )
    .max(256),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type PlanRecord = z.infer<typeof PlanRecordSchema>;
export type PlanClaim = Pick<
  PlanRecord,
  | "parentAgentId"
  | "conversationId"
  | "parentExecutionId"
  | "parentToolCallId"
  | "requestHash"
  | "request"
  | "schedulerThreadId"
>;
export type PlanMutation = (record: PlanRecord) => PlanRecord;
export const finishedPlan = (plan: PlanRecord) =>
  !["running", "waiting_approval", "cancelling"].includes(plan.status);

/** Validate the whole DAG and allowlist before reserving work or opening worker graphs. */
export function validatePlan(
  input: DelegationPlan,
  parent: RegisteredAgentDefinition,
  registry: AgentRegistry,
): DelegationPlan {
  const plan = DelegationPlanSchema.parse(input);
  if (plan.tasks.length > parent.delegation.maxTasks)
    throw new DelegationRejected("Delegation task-count limit exceeded");
  const tasks = new Map(plan.tasks.map((task) => [task.key, task]));
  if (tasks.size !== plan.tasks.length) throw new DelegationRejected("Task keys must be unique");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key))
      throw new DelegationRejected("Task dependencies must not contain cycles");
    const task = tasks.get(key);
    if (!task) throw new DelegationRejected(`Unknown task dependency: ${key}`);
    if (!parent.delegation.agents.includes(task.agentId) || parent.id === task.agentId)
      throw new DelegationRejected(`Agent "${parent.id}" cannot delegate to "${task.agentId}"`);
    registry.get(task.agentId);
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new DelegationRejected("Task dependencies must be unique");
    visiting.add(key);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of tasks.keys()) visit(key);
  return plan;
}

/** Only workers without external capabilities may share an execution wave. */
export function parallelSafe(agent: RegisteredAgentDefinition): boolean {
  const c = agent.capabilities;
  return (
    !c.useGlobalTools.length &&
    !c.tools.length &&
    !c.useGlobalMcpServers.length &&
    !c.mcp.length &&
    c.memory === "none" &&
    c.skills !== "all" &&
    !c.skills.length
  );
}
export function newPlan(input: PlanClaim): PlanRecord {
  return PlanRecordSchema.parse({
    ...input,
    planId: randomUUID(),
    status: "running",
    version: 0,
    ownerToken: null,
    leaseExpiresAt: null,
    results: [],
    approvalRounds: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
}
export function mutatePlan(current: PlanRecord, mutation: PlanMutation): PlanRecord {
  const next = mutation(structuredClone(current));
  for (const key of [
    "planId",
    "parentAgentId",
    "conversationId",
    "parentExecutionId",
    "parentToolCallId",
    "requestHash",
    "request",
    "schedulerThreadId",
    "startedAt",
  ] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key]))
      throw new Error("Plan mutation changed immutable identity");
  }
  if (finishedPlan(current) && JSON.stringify(next) !== JSON.stringify(current))
    throw new Error("Terminal plans are immutable");
  return PlanRecordSchema.parse({ ...next, version: current.version + 1 });
}
