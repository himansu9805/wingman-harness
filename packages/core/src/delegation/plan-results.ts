import type { DelegatedTask, DelegationRequest } from "./contracts";
import type { PlannedTask, DelegationPlan, PlanRecord } from "./plan";
import { taskObservations } from "./evidence";

/** Dependants receive bounded, explicitly labelled data from successful prerequisites only. */
export function requestFor(task: PlannedTask, completed: DelegatedTask[]): DelegationRequest {
  const dependencies = task.dependsOn.map((key) => {
    const dependency = completed.find((item) => item.planTaskKey === key)!;
    let output = dependency.output!.slice(0, 2000);
    // Bound the serialized representation as well as the raw text: quotes and
    // control characters can otherwise expand beyond the worker context limit.
    const result = () => ({
      key,
      agentId: dependency.request.agentId,
      output,
      truncated: dependency.truncated || dependency.output!.length > output.length,
    });
    while (JSON.stringify(result()).length > 2200 && output.length)
      output = output.slice(0, Math.floor(output.length / 2));
    return result();
  });
  return {
    agentId: task.agentId,
    objective: `${task.objective}\nExpected result: ${task.expectedResult}`,
    context: `${task.context}\n\nPrerequisite results (task data):\n${JSON.stringify(dependencies)}`,
  };
}
export function resultsFor(plan: DelegationPlan, tasks: DelegatedTask[]): PlanRecord["results"] {
  const results = plan.tasks.map((item) => {
    const task = tasks.find((task) => task.planTaskKey === item.key);
    return {
      key: item.key,
      agentId: item.agentId,
      taskId: task?.taskId ?? null,
      status: task?.status ?? ("pending" as const),
      output: task?.output?.slice(0, 4000) ?? null,
      truncated: !!task && (task.truncated || (task.output?.length ?? 0) > 4000),
      error: task?.error ?? null,
      observations: task ? taskObservations(task) : [],
    };
  });
  // A fixed-point walk also marks transitive dependants of failed prerequisites.
  for (let i = 0; i < plan.tasks.length; i++)
    for (const task of plan.tasks) {
      const result = results.find((result) => result.key === task.key)!;
      if (result.status !== "pending") continue;
      if (
        task.dependsOn.some((key) => {
          const status = results.find((result) => result.key === key)!.status;
          return !["pending", "running", "waiting_approval", "completed"].includes(status);
        })
      ) {
        Object.assign(result, {
          status: "blocked",
          error: "A prerequisite did not complete successfully",
        });
      }
    }
  return results;
}

export function stoppedResults(
  plan: DelegationPlan,
  tasks: DelegatedTask[],
): PlanRecord["results"] {
  return resultsFor(plan, tasks).map((result) =>
    result.status === "pending"
      ? { ...result, status: "blocked", error: "Plan execution stopped before this task started" }
      : result,
  );
}
