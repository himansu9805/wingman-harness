import { mapStoredMessageToChatMessage, ToolMessage } from "@langchain/core/messages";
import type { DelegatedTask, TaskObservation } from "./contracts";

/** Project recent persisted tool responses without promoting them into a final answer. */
export function taskObservations(task: DelegatedTask): TaskObservation[] {
  return task.tools
    .filter((entry) => entry.status === "completed" && entry.result)
    .slice(-4)
    .map((entry) => {
      const result = mapStoredMessageToChatMessage(entry.result!);
      if (!ToolMessage.isInstance(result)) throw new Error("Invalid persisted tool evidence");
      const requestedUrl = entry.requestedUrl ?? null;
      const text = typeof result.content === "string" ? result.content : result.text;
      return {
        toolCallId: entry.toolCallId,
        tool: entry.name,
        status: result.status === "error" ? "error" : "success",
        requestedUrl: requestedUrl && requestedUrl.length <= 500 ? requestedUrl : null,
        content: text.slice(0, 500),
        truncated: text.length > 500 || (requestedUrl?.length ?? 0) > 500,
      };
    });
}
