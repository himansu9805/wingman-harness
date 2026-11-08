import type { ThreadEvent, ToolCall } from "../api/types";
import type { DelegationPlanSnapshot, DelegationTask } from "../api/delegation";

export function delegatedPlans(events: ThreadEvent[]): DelegationPlanSnapshot[] {
  const plans = new Map<string, DelegationPlanSnapshot>();
  for (const event of events) if (event.type === "delegation_plan") plans.set(event.planId, event);
  return [...plans.values()];
}
export function taskStatus(
  status: DelegationTask["status"] | DelegationPlanSnapshot["status"],
): string {
  return {
    pending: "Pending",
    running: "Working",
    waiting_approval: "Awaiting approval",
    completed: "Completed",
    failed: "Failed",
    blocked: "Blocked",
    interrupted: "Stopped",
    cancelled: "Cancelled",
    recovery_required: "Needs review",
    partial: "Partially completed",
    cancelling: "Cancelling",
  }[status];
}
export function tokenLabel(usage: DelegationTask["usage"]): string {
  if (!usage.modelCalls) return "No model calls";
  if (usage.availability === "unavailable") return "Token usage unavailable";
  if (usage.totalTokens === null) return "Token usage incomplete";
  return `${usage.availability === "partial" ? "At least " : ""}${usage.totalTokens.toLocaleString()} tokens`;
}

/** Match tool requests and results inside their owning execution, including reused IDs. */
export function taskCalls(taskId: string | null, events: ThreadEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== "agent_activity" || event.taskId !== taskId) continue;
    const activity = event.event;
    if (!activity.toolCallId) continue;
    if (activity.type === "tool_result") {
      const previous = calls.get(activity.toolCallId);
      if (previous)
        calls.set(activity.toolCallId, {
          ...previous,
          result: { output: activity.output, truncated: activity.truncated },
        });
    } else {
      const args = activity.type === "skill" ? { name: activity.name } : activity.args;
      calls.set(activity.toolCallId, {
        id: activity.toolCallId,
        name: activity.type === "skill" ? "load_skill" : activity.name,
        args:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : { value: args },
      });
    }
  }
  return [...calls.values()];
}
