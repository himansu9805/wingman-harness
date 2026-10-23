import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { Agent } from "./agent";
import { previewToolOutput } from "./tool-output";

/** A user-visible message, with tool results attached to their assistant call. */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: { output: string; truncated: boolean };
  }>;
}

/** Reads the latest conversation, or the selected checkpoint's conversation. */
export async function getThreadMessages(
  agent: Agent,
  threadId: string,
  checkpointId?: string,
): Promise<{ checkpointId?: string; messages: ConversationMessage[] }> {
  const state = await agent.app.graph.getState({
    configurable: {
      thread_id: threadId,
      ...(checkpointId !== undefined ? { checkpoint_id: checkpointId } : {}),
    },
  });
  const originalMessages: unknown[] = Array.isArray(state.values?.messages)
    ? state.values.messages
    : [];
  // Duplicate unresolved IDs consume results FIFO. Only preceding calls qualify;
  // completed calls are removed so later turns cannot overwrite their results.
  const unresolved = new Map<
    string,
    NonNullable<ConversationMessage["toolCalls"]>
  >();

  const messages: ConversationMessage[] = [];
  for (const [index, message] of originalMessages.entries()) {
    if (ToolMessage.isInstance(message)) {
      const queue = unresolved.get(message.tool_call_id);
      const call = queue?.shift();
      if (call) call.result = previewToolOutput(message.content);
      if (queue?.length === 0) unresolved.delete(message.tool_call_id);
      continue;
    }
    if (!HumanMessage.isInstance(message) && !AIMessage.isInstance(message)) {
      continue;
    }
    const visible: ConversationMessage = {
      id: message.id ?? `message-${index}`,
      role: HumanMessage.isInstance(message) ? "user" : "assistant",
      text: message.text,
    };
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      visible.toolCalls = message.tool_calls.map((call, callIndex) => {
        const visibleCall = {
          id: call.id ?? `message-${index}-tool-${callIndex}`,
          name: call.name,
          args: call.args,
        };
        if (call.id !== undefined) {
          const queue = unresolved.get(call.id) ?? [];
          queue.push(visibleCall);
          unresolved.set(call.id, queue);
        }
        return visibleCall;
      });
    }
    messages.push(visible);
  }
  return {
    checkpointId: state.config?.configurable?.checkpoint_id,
    messages,
  };
}

/** Removes all saved state for a thread through the checkpointer's public API. */
export async function deleteThreadState(
  agent: Agent,
  threadId: string,
): Promise<void> {
  const checkpointer = agent.app.graph.checkpointer;
  if (
    !checkpointer ||
    typeof checkpointer === "boolean" ||
    typeof checkpointer.deleteThread !== "function"
  ) {
    throw new Error("The graph checkpointer does not support thread deletion");
  }
  await checkpointer.deleteThread(threadId);
}
