import { addUsage, type TokenUsage } from "../telemetry/usage";
import type { DelegationPlanSnapshot } from "./contracts";

/** Reconcile reserved worker calls that never delivered a provider usage report. */
export class DelegatedUsageTracker {
  private readonly baseline = new Map<string, number>();
  private readonly latest = new Map<string, number>();
  private readonly reported = new Map<string, number>();
  observe(snapshot: DelegationPlanSnapshot): void {
    for (const task of snapshot.tasks) {
      if (!task.taskId) continue;
      if (!this.baseline.has(task.taskId)) this.baseline.set(task.taskId, task.usage.modelCalls);
      this.latest.set(task.taskId, task.usage.modelCalls);
    }
  }
  report(taskId: string): void {
    this.reported.set(taskId, (this.reported.get(taskId) ?? 0) + 1);
  }
  finish(usage: TokenUsage): TokenUsage {
    let result = usage;
    for (const [id, calls] of this.latest) {
      const missing = Math.max(0, calls - this.baseline.get(id)! - (this.reported.get(id) ?? 0));
      for (let i = 0; i < missing; i++)
        result = addUsage(result, {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
        });
    }
    return result;
  }
}
