import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { DelegationRequestSchema, DelegationRejected, DelegationBusyError, type DelegationIdentity, type DelegationRequest, type DelegatedTask, type DelegationStream } from "./types";

export type Delegate = (request: DelegationRequest, identity: DelegationIdentity, invocation: {
  signal?: AbortSignal; schedulerThreadId?: string; emit(frame: DelegationStream): void;
}) => Promise<DelegatedTask>;

/** Bind delegation to a trusted parent allowlist; models supply only objective and context. */
export function createDelegationTool(delegate: Delegate, resume: (taskId: string, answers: Record<string, boolean>, invocation: Parameters<Delegate>[2]) => Promise<DelegatedTask>, targets: readonly { id: string; description: string }[]) {
  return tool(async (request, runtime: ToolRuntime<{ messages: unknown[] }>) => {
    const conversationId = runtime.config.configurable?.thread_id;
    const messages = [...runtime.state.messages].reverse();
    const parent = messages.find(HumanMessage.isInstance);
    const call = messages.find(AIMessage.isInstance);
    if (typeof conversationId !== "string" || !parent?.id || !runtime.toolCallId) {
      throw new Error("Delegation requires persisted conversation, user-message and tool-call identities");
    }
    if (call?.tool_calls?.length !== 1) {
      return JSON.stringify({ status: "rejected", error: "Call delegate_task alone, without parallel tool requests" });
    }
    try {
      const schedulerThreadId = runtime.config.configurable?.scheduler_thread_id;
      const invocation = { signal: runtime.config.signal, ...(typeof schedulerThreadId === "string" ? { schedulerThreadId } : {}), emit: (frame: DelegationStream) => runtime.writer?.(frame) };
      let task = await delegate(request, {
        conversationId, parentExecutionId: parent.id, parentToolCallId: runtime.toolCallId,
      }, invocation);
      // Revisit earlier interrupt positions during graph replay. Only the
      // unresolved durable round can resume the child; earlier answers are inert.
      let roundIndex = 0;
      while (task.status === "waiting_approval" && roundIndex < task.approvalRounds.length) {
        const round = task.approvalRounds[roundIndex]!;
        const answers = interrupt<import("../approvals").ApprovalPayload, Record<string, boolean>>({
          kind: "delegated_approvals", taskId: task.taskId, approvals: round.approvals,
        });
        if (!round.answers) task = await resume(task.taskId, answers, invocation);
        roundIndex++;
      }
      return JSON.stringify({ taskId: task.taskId, agentId: task.request.agentId, status: task.status,
        output: task.output, truncated: task.truncated,
        error: task.status === "running" ? "Execution is active or its outcome is uncertain; automatic retry is disabled" : task.error,
        startedAt: task.startedAt, finishedAt: task.finishedAt });
    } catch (error) {
      if (error instanceof DelegationRejected) return JSON.stringify({ status: "rejected", error: error.message });
      if (isGraphInterrupt(error) || runtime.config.signal?.aborted) throw error;
      return JSON.stringify({ status: error instanceof DelegationBusyError ? "blocked" : "recovery_required",
        error: error instanceof DelegationBusyError ? error.message : "Specialist state could not be saved or recovered; automatic retry is disabled" });
    }
  }, {
    name: "delegate_task",
    description: `Delegate one bounded task to a specialist when useful. Call this tool alone, at most once per user turn. Supply only necessary context. Available specialists: ${targets.map(target => `${target.id}: ${target.description}`).join("; ")}`,
    schema: DelegationRequestSchema,
  });
}
