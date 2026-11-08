import {
  addUsage,
  emptyUsage,
  DelegatedUsageTracker,
  type TokenUsage,
  type TurnOptions,
  type TurnEventHandler,
  type Decide,
} from "@wingman/core/turns";
import type { DelegationPlanSnapshot } from "@wingman/core/turns";

const labels = {
  running: "Working",
  pending: "Pending",
  waiting_approval: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  interrupted: "Stopped",
  cancelled: "Cancelled",
  recovery_required: "Needs review",
  partial: "Partially completed",
  cancelling: "Cancelling",
};
const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;

/** Print state transitions once, keeping worker breakdowns separate from inclusive totals. */
export class DelegationReporter {
  private readonly plans = new Map<
    string,
    { signature: string; tasks: Map<string, string>; owners: Map<string, string> }
  >();
  constructor(private readonly write: (line: string) => void) {}
  owner(taskId: string | null, agentId: string): string {
    for (const plan of this.plans.values())
      if (taskId && plan.owners.has(taskId)) return plan.owners.get(taskId)!;
    return agentId;
  }
  update(snapshot: DelegationPlanSnapshot): void {
    const previous = this.plans.get(snapshot.planId) ?? {
      signature: "",
      tasks: new Map(),
      owners: new Map(),
    };
    const signature = `${snapshot.status}:${snapshot.error}`;
    const changed = signature !== previous.signature;
    if (changed) {
      this.write(
        `  🤝 Plan ${snapshot.planId.slice(0, 8)}: ${snapshot.error ? "Needs review" : labels[snapshot.status]} · ${snapshot.tasks.length} tasks · ${duration(snapshot.elapsedMs)} elapsed`,
      );
      if (snapshot.error) this.write(`     ${snapshot.error}`);
      previous.signature = signature;
    }
    for (const task of snapshot.tasks) {
      if (task.taskId) previous.owners.set(task.taskId, `${task.key} [${task.agentId}]`);
      const terminal = !["running", "pending", "waiting_approval"].includes(task.status);
      const declines = task.decisions.filter((item) => !item.approved).length;
      const key = `${declines}:${task.status}:${task.error}:${terminal ? JSON.stringify(task.usage) : ""}`;
      if (previous.tasks.get(task.key) === key) continue;
      const usage = !task.usage.modelCalls
        ? "No model calls"
        : task.usage.availability === "unavailable" || task.usage.totalTokens === null
          ? "Token usage unavailable"
          : `${task.usage.availability === "partial" ? "at least " : ""}${task.usage.totalTokens} tokens`;
      this.write(
        `     ↳ ${task.key} [${task.agentId}]: ${labels[task.status]}${declines ? ` · ${declines} command${declines === 1 ? "" : "s"} declined by user` : ""}${terminal ? ` · ${duration(task.processingMs)} processing · ${usage} · ${task.usage.modelCalls} model calls` : ""}`,
      );
      if (task.error) this.write(`       ${task.error}`);
      previous.tasks.set(task.key, key);
    }
    if (
      ["completed", "partial", "failed", "cancelled", "recovery_required"].includes(
        snapshot.status,
      ) &&
      changed
    ) {
      this.write("     Task tokens are included in the turn total. Parallel durations overlap.");
    }
    this.plans.set(snapshot.planId, previous);
    if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value!);
  }
}

/** One inclusive invocation total; worker snapshots only reconcile missing reports. */
export class TurnAccounting {
  private usage = emptyUsage();
  private readonly delegated = new DelegatedUsageTracker();
  private readonly startedAt = performance.now();
  private approvalWaitMs = 0;

  options(signal: AbortSignal, onEvent: TurnEventHandler): TurnOptions {
    return {
      signal,
      onEvent: async (event) => {
        if (event.type === "delegation_plan") this.delegated.observe(event);
        await onEvent(event);
      },
      onModelUsage: async (counts, _messageId, source) => {
        if (source) this.delegated.report(source.taskId);
        this.usage = addUsage(this.usage, counts);
      },
    };
  }
  decide(decide: Decide): Decide {
    return async (approval) => {
      const start = performance.now();
      try {
        return await decide(approval);
      } finally {
        this.approvalWaitMs += performance.now() - start;
      }
    };
  }
  totals(): TokenUsage {
    return this.delegated.finish(this.usage);
  }
  summary(): string {
    const usage = this.totals();
    const elapsed = performance.now() - this.startedAt;
    const tokens =
      usage.availability === "unavailable" || usage.totalTokens === null
        ? "Token usage unavailable"
        : `${usage.availability === "partial" ? "At least " : ""}${usage.totalTokens} tokens`;
    return `  Total: ${tokens} · ${usage.modelCalls} model calls · ${duration(Math.max(0, elapsed - this.approvalWaitMs))} processing · ${duration(this.approvalWaitMs)} approval wait (coordinator + workers; router excluded)`;
  }
}
