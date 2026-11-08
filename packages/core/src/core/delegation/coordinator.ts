import { createHash, randomUUID } from "node:crypto";
import type { AgentRegistry, RegisteredAgentDefinition } from "../agents/registry";
import type { DelegationStore } from "./store";
import type { DelegationRunner } from "./runner";
import {
  DelegationBusyError,
  DelegationRejected,
  type DelegatedTask,
  type DelegationIdentity,
  type DelegationRequest,
  type DelegationStream,
} from "./types";
import {
  validatePlan,
  parallelSafe,
  finishedPlan,
  type DelegationPlan,
  type PlannedTask,
  type PlanRecord,
  type PlanMutation,
} from "./plan";
import { WorkerSlots } from "./slots";

export interface PlanInvocation {
  signal?: AbortSignal;
  schedulerThreadId?: string;
  emit(frame: DelegationStream): void;
}
const LEASE_MS = 15000;

/** One coordinator and one fair worker queue per runtime, shared by every agent and chat. */
export class DelegationCoordinator {
  private readonly slots: WorkerSlots;
  private readonly active = new Map<
    string,
    { conversationId: string; controller: AbortController; promise: Promise<PlanRecord> }
  >();
  private closing?: Promise<void>;
  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: DelegationStore,
    private readonly workers: DelegationRunner,
    concurrency = 4,
  ) {
    this.slots = new WorkerSlots(concurrency);
  }

  /** Reserve a single immutable plan per user message before executing its DAG. */
  async run(
    parentId: string,
    input: DelegationPlan,
    identity: DelegationIdentity,
    invocation: PlanInvocation,
  ): Promise<PlanRecord> {
    if (this.closing) throw new DelegationRejected("Delegation runtime is stopping");
    invocation.signal?.throwIfAborted();
    const parent = this.registry.get(parentId);
    const request = validatePlan(input, parent, this.registry);
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const { plan } = await this.store.claimPlan({
      ...identity,
      parentAgentId: parentId,
      request,
      requestHash,
      schedulerThreadId: invocation.schedulerThreadId ?? null,
    });
    if (plan.parentAgentId !== parentId || plan.parentToolCallId !== identity.parentToolCallId)
      throw new DelegationRejected("Only one delegation plan is allowed per user turn");
    if (plan.requestHash !== requestHash)
      throw new DelegationRejected("Plan identity was reused with different task data");
    const active = this.active.get(plan.planId);
    if (active) return active.promise;
    if (finishedPlan(plan) || plan.status === "waiting_approval") return plan;
    if (plan.status === "cancelling")
      throw new DelegationBusyError("Plan cancellation is still pending");
    return this.launch(parent, plan, invocation);
  }

  /** An answer batch belongs to one persisted plan round and its exact child interrupts. */
  async resume(
    parentId: string,
    planId: string,
    answers: Record<string, boolean>,
    invocation: PlanInvocation,
  ): Promise<PlanRecord> {
    const plan = await this.store.getPlan(planId);
    if (plan.parentAgentId !== parentId)
      throw new DelegationRejected("Plan belongs to another parent agent");
    if (finishedPlan(plan)) return plan;
    if (plan.status !== "waiting_approval")
      throw new DelegationBusyError("Plan is not waiting for approval");
    const round = plan.approvalRounds.at(-1)!;
    const ids = new Set(round.approvals.map((item) => item.id));
    if (
      !ids.size ||
      Object.keys(answers).length !== ids.size ||
      !Object.entries(answers).every(([id, answer]) => ids.has(id) && typeof answer === "boolean")
    )
      throw new DelegationRejected("Answer every plan approval exactly once");
    const parent = this.registry.get(parentId);
    validatePlan(plan.request, parent, this.registry);
    return this.launch(parent, plan, invocation, answers);
  }

  private launch(
    parent: RegisteredAgentDefinition,
    snapshot: PlanRecord,
    invocation: PlanInvocation,
    answers?: Record<string, boolean>,
  ): Promise<PlanRecord> {
    if (this.closing) throw new DelegationRejected("Delegation runtime is stopping");
    if (this.active.has(snapshot.planId))
      throw new DelegationBusyError("Plan execution already claimed");
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(invocation.signal ? [invocation.signal] : []),
    ]);
    const promise = this.execute(
      parent,
      snapshot,
      { ...invocation, signal },
      controller,
      answers,
    ).finally(() => this.active.delete(snapshot.planId));
    this.active.set(snapshot.planId, {
      conversationId: snapshot.conversationId,
      controller,
      promise,
    });
    return promise;
  }

  private async execute(
    parent: RegisteredAgentDefinition,
    snapshot: PlanRecord,
    invocation: PlanInvocation & { signal: AbortSignal },
    controller: AbortController,
    answers?: Record<string, boolean>,
  ): Promise<PlanRecord> {
    const owner = randomUUID();
    const plan = await this.store.updatePlan(snapshot.planId, (current) => {
      if (
        current.version !== snapshot.version ||
        (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > Date.now())
      )
        throw new DelegationBusyError("Plan is owned by another execution");
      if (answers) current.approvalRounds[current.approvalRounds.length - 1]!.answers = answers;
      return {
        ...current,
        status: "running",
        ownerToken: owner,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      };
    });
    const update = (mutation: PlanMutation) =>
      this.store.updatePlan(plan.planId, (current) => {
        if (
          current.status !== "running" ||
          current.ownerToken !== owner ||
          !current.leaseExpiresAt ||
          Date.parse(current.leaseExpiresAt) <= Date.now()
        )
          throw new DelegationBusyError("Plan ownership expired");
        return mutation(current);
      });
    // The plan may wait for a global permit or several worker waves. A short
    // renewable lease makes process-loss recovery prompt without taking over live work.
    let heartbeat: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = update((current) => ({
        ...current,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      }))
        .catch((error) => controller.abort(error))
        .finally(() => {
          heartbeat = undefined;
        });
    }, LEASE_MS / 3);
    timer.unref();
    try {
      return await this.advance(parent, plan, invocation, update, answers);
    } catch (error) {
      // Keep the children authoritative. A lost coordinator lease must never
      // overwrite another coordinator's state or retry an uncertain action.
      const current = await this.store.getPlan(plan.planId);
      if (current.ownerToken !== owner || current.status !== "running") throw error;
      if (!invocation.signal.aborted) {
        await this.store.updatePlan(plan.planId, (record) => {
          if (record.ownerToken !== owner) throw error;
          return { ...record, ownerToken: null, leaseExpiresAt: null };
        });
        throw error;
      }
      const results = stoppedResults(plan.request, await this.store.listPlanTasks(plan.planId));
      return await this.store.updatePlan(plan.planId, (record) => {
        if (record.ownerToken !== owner || record.status !== "running")
          throw new DelegationBusyError("Plan ownership changed");
        return {
          ...record,
          results,
          status: invocation.signal.aborted ? "cancelled" : "recovery_required",
          ownerToken: null,
          leaseExpiresAt: null,
          finishedAt: new Date().toISOString(),
          error:
            "Plan execution stopped; completed results were retained and uncertain actions will not be retried",
        };
      });
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }

  /** Advance the DAG until every ready wave settles or human approval is needed. */
  private async advance(
    parent: RegisteredAgentDefinition,
    plan: PlanRecord,
    invocation: PlanInvocation & { signal: AbortSignal },
    update: (mutation: PlanMutation) => Promise<PlanRecord>,
    answers?: Record<string, boolean>,
  ): Promise<PlanRecord> {
    if (answers) {
      const tasks = await this.store.listPlanTasks(plan.planId);
      await this.runWave(
        parent,
        tasks
          .filter((task) => task.status === "waiting_approval")
          .map((task) => ({
            agentId: task.request.agentId,
            run: async () => {
              const childAnswers = Object.fromEntries(
                task.pendingApprovals.map((item) => [
                  item.id,
                  answers[`${task.taskId}:${item.id}`]!,
                ]),
              );
              return this.workers.resume(parent.id, task.taskId, childAnswers, invocation);
            },
          })),
        invocation,
        update,
      );
    }
    while (true) {
      invocation.signal.throwIfAborted();
      const tasks = await this.store.listPlanTasks(plan.planId);
      const running = tasks.filter((task) => task.status === "running");
      if (running.length) {
        await this.runWave(
          parent,
          running.map((task) => ({
            agentId: task.request.agentId,
            run: () =>
              this.workers.run(
                parent.id,
                task.request,
                {
                  conversationId: task.conversationId,
                  parentExecutionId: task.parentExecutionId,
                  parentToolCallId: task.parentToolCallId,
                  planId: plan.planId,
                  planTaskKey: task.planTaskKey,
                },
                invocation,
              ),
          })),
          invocation,
          update,
        );
        continue;
      }
      const results = resultsFor(plan.request, tasks);
      const waiting = tasks.filter((task) => task.status === "waiting_approval");
      if (waiting.length) {
        const approvals = waiting.flatMap((task) =>
          task.pendingApprovals.map((approval) => ({
            ...approval,
            id: `${task.taskId}:${approval.id}`,
          })),
        );
        return await update((current) => ({
          ...current,
          status: "waiting_approval",
          results,
          ownerToken: null,
          leaseExpiresAt: null,
          approvalRounds: [...current.approvalRounds, { approvals, answers: null }],
        }));
      }
      const ready = plan.request.tasks.filter(
        (task) =>
          results.find((result) => result.key === task.key)!.status === "pending" &&
          task.dependsOn.every(
            (key) => results.find((result) => result.key === key)!.status === "completed",
          ),
      );
      if (!ready.length) {
        const status = results.every((result) => result.status === "completed")
          ? "completed"
          : results.some((result) => result.status === "recovery_required")
            ? "recovery_required"
            : results.some((result) => result.status === "completed")
              ? "partial"
              : "failed";
        return await update((current) => ({
          ...current,
          status,
          results,
          ownerToken: null,
          leaseExpiresAt: null,
          finishedAt: new Date().toISOString(),
        }));
      }
      const first = ready[0]!;
      const wave = parallelSafe(this.registry.get(first.agentId))
        ? ready
            .slice(0, parent.delegation.maxConcurrency)
            .filter((task) => parallelSafe(this.registry.get(task.agentId)))
        : [first];
      await this.runWave(
        parent,
        wave.map((task) => ({
          agentId: task.agentId,
          run: () =>
            this.workers.run(
              parent.id,
              requestFor(task, tasks),
              {
                conversationId: plan.conversationId,
                parentExecutionId: plan.parentExecutionId,
                parentToolCallId: plan.parentToolCallId,
                planId: plan.planId,
                planTaskKey: task.key,
              },
              {
                ...invocation,
                ...(plan.schedulerThreadId ? { schedulerThreadId: plan.schedulerThreadId } : {}),
              },
            ),
        })),
        invocation,
        update,
      );
      const updated = await this.store.listPlanTasks(plan.planId);
      await update((current) => ({ ...current, results: resultsFor(plan.request, updated) }));
    }
  }

  /** Drain the entire wave before pausing, failing or starting dependants. */
  private async runWave(
    parent: RegisteredAgentDefinition,
    jobs: readonly { agentId: string; run(): Promise<DelegatedTask> }[],
    invocation: PlanInvocation & { signal: AbortSignal },
    update: (mutation: PlanMutation) => Promise<PlanRecord>,
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      jobs.map(async (job) => {
        const agentId = job.agentId;
        const queueSignal = AbortSignal.any([
          invocation.signal,
          AbortSignal.timeout(parent.delegation.timeoutMs),
        ]);
        const release = await this.slots.acquire(
          !parallelSafe(this.registry.get(agentId)),
          queueSignal,
        );
        try {
          invocation.signal.throwIfAborted();
          await update((current) => current);
          return await job.run();
        } finally {
          release();
        }
      }),
    );
    const failed = outcomes.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Stop plan dispatch first, then drain and cancel all of its child executions. */
  async cancelConversation(conversationId: string): Promise<void> {
    const active = [...this.active.values()].filter(
      (item) => item.conversationId === conversationId,
    );
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.promise));
    while (true) {
      const plans = await this.store.listPlans(conversationId, true);
      if (!plans.length) break;
      // Persist cancellation intent before touching children so interrupted
      // cleanup cannot make unstarted tasks eligible for dispatch again.
      for (const plan of plans)
        await this.store.updatePlan(plan.planId, (current) => {
          if (finishedPlan(current)) return current;
          if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > Date.now())
            throw new DelegationBusyError("Plan is active in another process");
          return {
            ...current,
            status: "cancelling",
            ownerToken: null,
            leaseExpiresAt: null,
            error: "Parent turn abandoned",
          };
        });
      await this.workers.cancelConversation(conversationId);
      for (const plan of plans) {
        const tasks = await this.store.listPlanTasks(plan.planId);
        await this.store.updatePlan(plan.planId, (current) => {
          if (finishedPlan(current)) return current;
          return {
            ...current,
            status: "cancelled",
            results: stoppedResults(plan.request, tasks),
            finishedAt: new Date().toISOString(),
          };
        });
      }
    }
    await this.workers.cancelConversation(conversationId);
  }
  async deleteConversation(conversationId: string): Promise<void> {
    await this.cancelConversation(conversationId);
    await this.workers.deleteConversation(conversationId);
    while (true) {
      const plans = await this.store.listPlans(conversationId);
      if (!plans.length) return;
      for (const plan of plans) await this.store.deletePlan(plan.planId);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const item of this.active.values()) item.controller.abort();
      await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    })());
  }
}

/** Dependants receive bounded, explicitly labelled data from successful prerequisites only. */
function requestFor(task: PlannedTask, completed: DelegatedTask[]): DelegationRequest {
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
function resultsFor(plan: DelegationPlan, tasks: DelegatedTask[]): PlanRecord["results"] {
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

function stoppedResults(plan: DelegationPlan, tasks: DelegatedTask[]): PlanRecord["results"] {
  return resultsFor(plan, tasks).map((result) =>
    result.status === "pending"
      ? { ...result, status: "blocked", error: "Plan execution stopped before this task started" }
      : result,
  );
}
