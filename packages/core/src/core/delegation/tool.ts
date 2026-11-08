import { DelegationPlanSchema, type DelegationPlan, type PlanRecord } from "./plan";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import {
  DelegationRejected,
  DelegationBusyError,
  type DelegationIdentity,
  type DelegationStream,
} from "./types";

export type Delegate = (
  request: DelegationPlan,
  identity: DelegationIdentity,
  invocation: {
    signal?: AbortSignal;
    schedulerThreadId?: string;
    emit(frame: DelegationStream): void;
  },
) => Promise<PlanRecord>;

/** Bind delegation to a trusted parent allowlist; models supply only objective and context. */
export function createDelegationTool(
  delegate: Delegate,
  resume: (
    planId: string,
    answers: Record<string, boolean>,
    invocation: Parameters<Delegate>[2],
  ) => Promise<PlanRecord>,
  targets: readonly { id: string; description: string }[],
) {
  return tool(
    async (request, runtime: ToolRuntime<{ messages: unknown[] }>) => {
      const conversationId = runtime.config.configurable?.thread_id;
      const messages = [...runtime.state.messages].reverse();
      const parent = messages.find(HumanMessage.isInstance);
      const call = messages.find(AIMessage.isInstance);
      if (typeof conversationId !== "string" || !parent?.id || !runtime.toolCallId) {
        throw new Error(
          "Delegation requires persisted conversation, user-message and tool-call identities",
        );
      }
      if (call?.tool_calls?.length !== 1) {
        return JSON.stringify({
          status: "rejected",
          error: "Call delegate_task alone, without parallel tool requests",
        });
      }
      try {
        const schedulerThreadId = runtime.config.configurable?.scheduler_thread_id;
        const invocation = {
          signal: runtime.config.signal,
          ...(typeof schedulerThreadId === "string" ? { schedulerThreadId } : {}),
          emit: (frame: DelegationStream) => runtime.writer?.(frame),
        };
        let plan = await delegate(
          request,
          {
            conversationId,
            parentExecutionId: parent.id,
            parentToolCallId: runtime.toolCallId,
          },
          invocation,
        );
        // Revisit earlier interrupt positions during graph replay. Only the
        // unresolved durable round can resume the child; earlier answers are inert.
        let roundIndex = 0;
        while (plan.status === "waiting_approval" && roundIndex < plan.approvalRounds.length) {
          const round = plan.approvalRounds[roundIndex]!;
          const answers = interrupt<
            import("../approvals").ApprovalPayload,
            Record<string, boolean>
          >({
            kind: "delegated_approvals",
            planId: plan.planId,
            approvals: round.approvals,
          });
          if (!round.answers) plan = await resume(plan.planId, answers, invocation);
          roundIndex++;
        }
        return JSON.stringify({
          planId: plan.planId,
          status: plan.status,
          results: plan.results,
          error: plan.error,
          startedAt: plan.startedAt,
          finishedAt: plan.finishedAt,
        });
      } catch (error) {
        if (error instanceof DelegationRejected)
          return JSON.stringify({ status: "rejected", error: error.message });
        if (isGraphInterrupt(error) || runtime.config.signal?.aborted) throw error;
        return JSON.stringify({
          status: error instanceof DelegationBusyError ? "blocked" : "recovery_required",
          error:
            error instanceof DelegationBusyError
              ? error.message
              : "Specialist state could not be saved or recovered; automatic retry is disabled",
        });
      }
    },
    {
      name: "delegate_task",
      description: `Delegate one bounded task plan when useful. Give every task a unique key, prerequisites and an expected result. Call this tool alone, at most once per user turn. Supply only necessary context. Available specialists: ${targets.map((target) => `${target.id}: ${target.description}`).join("; ")}`,
      schema: DelegationPlanSchema,
    },
  );
}
