import { createHash } from "node:crypto";
import { createMiddleware } from "langchain";
import { ToolMessage, mapStoredMessageToChatMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { DelegationStore } from "./store";
import { DelegationRejected, RecoveryRequired, type DelegatedTask } from "./types";

/** Fence every write so an expired worker cannot overwrite its successor. */
export function owned(task: DelegatedTask, owner: string): void {
  if (task.status !== "running" || task.ownerToken !== owner || Date.parse(task.leaseExpiresAt!) <= Date.now()) {
    throw new RecoveryRequired("Worker ownership expired");
  }
}

/** Persist budgets and tool outcomes before exposing them to the worker graph. */
export function executionMiddleware(store: DelegationStore, taskId: string, owner: string, maxModelCalls: number) {
  return createMiddleware({
    name: "DurableWorkerExecution",
    wrapModelCall: async (request, handler) => {
      await store.update(taskId, task => {
        owned(task, owner);
        if (task.tools.some(tool => tool.status === "uncertain" || tool.status === "running")) throw new RecoveryRequired("A previous tool outcome is uncertain");
        if (task.modelCalls >= maxModelCalls) throw new DelegationRejected("Specialist model-call budget exhausted");
        return { ...task, modelCalls: task.modelCalls + 1 };
      });
      const response = await handler(request);
      for (const call of response.tool_calls ?? []) {
        if (!request.tools.some(tool => "name" in tool && tool.name === call.name)) {
          throw new DelegationRejected("The specialist requested an unavailable tool");
        }
      }
      return response;
    },
    wrapToolCall: async (request, handler) => {
      if (!request.tool) throw new DelegationRejected("The specialist requested an unavailable tool");
      const { id, name, args } = request.toolCall;
      if (!id) throw new RecoveryRequired("Worker tool call has no stable ID");
      const hash = createHash("sha256").update(JSON.stringify({ name, args })).digest("hex");
      const snapshot = await store.get(taskId);
      owned(snapshot, owner);
      const previous = snapshot.tools.find(item => item.toolCallId === id);
      if (previous && (previous.hash !== hash || previous.name !== name)) throw new RecoveryRequired("Tool identity changed during replay");
      if (previous?.status === "completed") return mapStoredMessageToChatMessage(previous.result!) as ToolMessage;
      if (previous && previous.status !== "waiting_approval") throw new RecoveryRequired("Tool outcome is uncertain; automatic replay is disabled");
      await store.update(taskId, task => {
        owned(task, owner);
        const entry = task.tools.find(item => item.toolCallId === id);
        if (entry) {
          if (entry.status !== "waiting_approval") throw new RecoveryRequired("Tool is already executing");
          entry.status = "running"; entry.ownerToken = owner;
        } else {
          if (task.tools.length >= 32) throw new DelegationRejected("Specialist tool-call budget exhausted");
          task.tools.push({ toolCallId: id, name, hash, status: "running", ownerToken: owner, result: null });
        }
        return task;
      });
      try {
        let result = await handler(request);
        if (!ToolMessage.isInstance(result)) throw new RecoveryRequired("Worker tool returned an unsupported state mutation");
        if (JSON.stringify(result.toDict()).length > 64000) {
          result = new ToolMessage({ name, tool_call_id: id,
            content: JSON.stringify(result.content).slice(0, 16000) + "\n[Tool result truncated]" });
        }
        const stored = result.toDict();
        await store.update(taskId, task => {
          owned(task, owner);
          const entry = task.tools.find(item => item.toolCallId === id)!;
          entry.status = "completed"; entry.result = stored;
          return task;
        });
        return result;
      } catch (error) {
        await store.update(taskId, task => {
          owned(task, owner);
          task.tools.find(item => item.toolCallId === id)!.status = isGraphInterrupt(error) ? "waiting_approval" : "uncertain";
          return task;
        });
        throw error;
      }
    },
  });
}
