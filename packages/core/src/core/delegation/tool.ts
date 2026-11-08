import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { DelegationRequestSchema, DelegationRejected, type DelegationIdentity, type DelegationRequest, type DelegatedTask, type DelegationStream } from "./types";

export type Delegate = (request: DelegationRequest, identity: DelegationIdentity, invocation: {
  signal?: AbortSignal; emit(frame: DelegationStream): void;
}) => Promise<DelegatedTask>;

/** Bind delegation to a trusted parent allowlist; models supply only objective and context. */
export function createDelegationTool(delegate: Delegate, targets: readonly { id: string; description: string }[]) {
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
      const task = await delegate(request, {
        conversationId, parentExecutionId: parent.id, parentToolCallId: runtime.toolCallId,
      }, { signal: runtime.config.signal, emit: frame => runtime.writer?.(frame) });
      return JSON.stringify({ taskId: task.taskId, agentId: task.request.agentId, status: task.status,
        output: task.output, truncated: task.truncated,
        error: task.status === "running" ? "Execution is active or its outcome is uncertain; automatic retry is disabled" : task.error,
        startedAt: task.startedAt, finishedAt: task.finishedAt });
    } catch (error) {
      if (error instanceof DelegationRejected) return JSON.stringify({ status: "rejected", error: error.message });
      throw error;
    }
  }, {
    name: "delegate_task",
    description: `Delegate one bounded analysis task to a specialist when useful. Call this tool alone, at most once per user turn. Supply only necessary context. Available specialists: ${targets.map(target => `${target.id}: ${target.description}`).join("; ")}`,
    schema: DelegationRequestSchema,
  });
}
