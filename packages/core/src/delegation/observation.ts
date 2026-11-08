import { addUsage, emptyUsage, type TokenUsage } from "../telemetry/usage";
import {
  DelegationPlanSnapshotSchema,
  type DelegatedTask,
  type DelegationPlanSnapshot,
} from "./contracts";
import { finishedPlan, type PlanRecord } from "./plan";
import { resultsFor } from "./plan-results";

/** Missing reports remain unavailable, including attempts interrupted before reporting usage. */
export function taskUsage(task: DelegatedTask): TokenUsage {
  let usage = task.usage.reduce((total, entry) => addUsage(total, entry.usage), emptyUsage());
  const missing = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  };
  for (let i = task.usage.length; i < task.modelCalls; i++) usage = addUsage(usage, missing);
  return usage;
}

/** Project durable execution state without summing overlapping child durations. */
export function planSnapshot(
  plan: PlanRecord,
  tasks: DelegatedTask[],
  now = Date.now(),
): DelegationPlanSnapshot {
  const results = finishedPlan(plan) ? plan.results : resultsFor(plan.request, tasks);
  return DelegationPlanSnapshotSchema.parse({
    type: "delegation_plan",
    planId: plan.planId,
    conversationId: plan.conversationId,
    parentExecutionId: plan.parentExecutionId,
    parentToolCallId: plan.parentToolCallId,
    status: plan.status,
    startedAt: plan.startedAt,
    finishedAt: plan.finishedAt,
    asOf: new Date(now).toISOString(),
    elapsedMs: Math.max(
      0,
      (plan.finishedAt ? Date.parse(plan.finishedAt) : now) - Date.parse(plan.startedAt),
    ),
    error: plan.error,
    tasks: results.map((result) => {
      const definition = plan.request.tasks.find((task) => task.key === result.key)!;
      const task = tasks.find((task) => task.taskId === result.taskId);
      const activeUntil = task?.leaseExpiresAt
        ? Math.min(now, Date.parse(task.leaseExpiresAt) - 1000)
        : now;
      return {
        ...result,
        objective: definition.objective,
        dependsOn: definition.dependsOn,
        toolCount: task?.tools.length ?? 0,
        decisions: task ? toolDecisions(task) : [],
        startedAt: task?.startedAt ?? null,
        finishedAt: task?.finishedAt ?? null,
        elapsedMs: task
          ? Math.max(
              0,
              (task.finishedAt ? Date.parse(task.finishedAt) : now) - Date.parse(task.startedAt),
            )
          : 0,
        processingMs:
          (task?.processingMs ?? 0) +
          (task?.status === "running" && task.attemptStartedAt
            ? Math.max(0, activeUntil - Date.parse(task.attemptStartedAt))
            : 0),
        approvalWaitMs:
          (task?.approvalWaitMs ?? 0) +
          (task?.status === "waiting_approval" && task.pausedAt
            ? Math.max(0, now - Date.parse(task.pausedAt))
            : 0),
        usage: task ? taskUsage(task) : emptyUsage(),
      };
    }),
  });
}

/** Decisions come from saved approval rounds, not from guessing at tool-result text. */
function toolDecisions(task: DelegatedTask): { toolCallId: string; approved: boolean }[] {
  const decisions = new Map<string, { toolCallId: string; approved: boolean }>();
  for (const round of task.approvalRounds) {
    if (!round.answers) continue;
    for (const approval of round.approvals) {
      if (!Object.hasOwn(round.answers, approval.id)) continue;
      const toolCallId = approval.execution.toolCallId;
      decisions.set(toolCallId, { toolCallId, approved: round.answers[approval.id]! });
    }
  }
  return [...decisions.values()];
}
