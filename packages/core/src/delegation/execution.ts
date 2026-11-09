import { createHash } from "node:crypto";
import { createMiddleware, ToolInvocationError } from "langchain";
import { ToolMessage, mapStoredMessageToChatMessage } from "@langchain/core/messages";
import { ToolInputParsingException } from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { DelegationStore } from "./storage/store";
import { DelegationRejected, RecoveryRequired, type DelegatedTask } from "./contracts";

/** Fence every write so an expired worker cannot overwrite its successor. */
export function owned(task: DelegatedTask, owner: string): void {
  if (
    task.status !== "running" ||
    task.ownerToken !== owner ||
    Date.parse(task.leaseExpiresAt!) <= Date.now()
  ) {
    throw new RecoveryRequired("Worker ownership expired");
  }
}

/** Persist budgets and tool outcomes before exposing them to the worker graph. */
export function executionMiddleware(
  store: DelegationStore,
  taskId: string,
  owner: string,
  maxModelCalls: number,
  toolCallLimits: Readonly<Record<string, number>> = {},
) {
  return createMiddleware({
    name: "DurableWorkerExecution",
    wrapModelCall: async (request, handler) => {
      const task = await store.update(taskId, (task) => {
        owned(task, owner);
        if (task.tools.some((tool) => tool.status === "uncertain" || tool.status === "running"))
          throw new RecoveryRequired("A previous tool outcome is uncertain");
        if (task.modelCalls >= maxModelCalls)
          throw new DelegationRejected("Specialist model-call budget exhausted");
        return { ...task, modelCalls: task.modelCalls + 1 };
      });
      const remaining = Object.fromEntries(
        Object.entries(toolCallLimits).map(([name, limit]) => [
          name,
          Math.max(0, limit - task.tools.filter((entry) => entry.name === name).length),
        ]),
      );
      const modelRequest = Object.keys(remaining).length
        ? {
            ...request,
            tools: request.tools.filter(
              (tool) =>
                !("name" in tool) || typeof tool.name !== "string" || remaining[tool.name] !== 0,
            ),
            systemMessage: request.systemMessage.concat(
              `\n# Remaining tool-call allowances\n${JSON.stringify(remaining)}\nThese count attempts, including errors, across this task. Tools with zero remaining calls are unavailable. Use other permitted tools to assess existing evidence or return supported findings and gaps. Do not bypass an exhausted capability through another tool.`,
            ),
          }
        : request;
      const response = await handler(modelRequest);
      for (const call of response.tool_calls ?? []) {
        if (!modelRequest.tools.some((tool) => "name" in tool && tool.name === call.name)) {
          throw new DelegationRejected("The specialist requested an unavailable tool");
        }
      }
      return response;
    },
    wrapToolCall: async (request, handler) => {
      if (!request.tool)
        throw new DelegationRejected("The specialist requested an unavailable tool");
      const { id, name, args } = request.toolCall;
      if (!id) throw new RecoveryRequired("Worker tool call has no stable ID");
      const hash = createHash("sha256").update(JSON.stringify({ name, args })).digest("hex");
      const snapshot = await store.get(taskId);
      owned(snapshot, owner);
      const previous = snapshot.tools.find((item) => item.toolCallId === id);
      if (previous && (previous.hash !== hash || previous.name !== name))
        throw new RecoveryRequired("Tool identity changed during replay");
      if (previous?.status === "completed")
        return mapStoredMessageToChatMessage(previous.result!) as ToolMessage;
      if (previous && previous.status !== "waiting_approval")
        throw new RecoveryRequired("Tool outcome is uncertain; automatic replay is disabled");
      let budgetResult: ToolMessage | undefined;
      await store.update(taskId, (task) => {
        owned(task, owner);
        const entry = task.tools.find((item) => item.toolCallId === id);
        if (entry) {
          if (entry.status !== "waiting_approval")
            throw new RecoveryRequired("Tool is already executing");
          entry.status = "running";
          entry.ownerToken = owner;
        } else {
          if (task.tools.length >= 32)
            throw new DelegationRejected("Specialist tool-call budget exhausted");
          const limit = toolCallLimits[name];
          if (
            limit !== undefined &&
            task.tools.filter((item) => item.name === name).length >= limit
          ) {
            budgetResult = new ToolMessage({
              name,
              tool_call_id: id,
              status: "error",
              content: `Tool-call allowance exhausted for ${name} (${limit} attempts). This call was not dispatched. Use existing evidence and other available tools, or report missing information.`,
            });
          }
          task.tools.push({
            toolCallId: id,
            name,
            hash,
            requestedUrl:
              typeof args.url === "string" &&
              args.url.length <= 2000 &&
              /^https?:\/\//.test(args.url)
                ? args.url
                : null,
            status: budgetResult ? "completed" : "running",
            ownerToken: owner,
            result: budgetResult ? budgetResult.toDict() : null,
          });
        }
        return task;
      });
      if (budgetResult) return budgetResult;
      try {
        let result;
        try {
          result = await handler(request);
        } catch (error) {
          const validationError = error instanceof ToolInvocationError ? error.toolError : error;
          if (!(validationError instanceof ToolInputParsingException)) throw error;
          // Framework validation failed before the tool function was dispatched.
          result = new ToolMessage({
            name,
            tool_call_id: id,
            status: "error",
            content: `Invalid tool arguments. Follow the tool's declared schema. ${validationError.message.slice(0, 1000)}`,
          });
        }
        if (!ToolMessage.isInstance(result))
          throw new RecoveryRequired("Worker tool returned an unsupported state mutation");
        if (JSON.stringify(result.toDict()).length > 64000) {
          const status = result.status;
          let text = result.text;
          let truncated = text.length > 16000;
          const message = () =>
            new ToolMessage({
              name,
              tool_call_id: id,
              status,
              content: text
                ? text.slice(0, 16000) + (truncated ? "\n[Tool result truncated]" : "")
                : "[Non-text tool content exceeds the durable result limit and was omitted.]",
              artifact: { omitted: true },
            });
          let bounded = message();
          while (JSON.stringify(bounded.toDict()).length > 64000 && text.length) {
            text = text.slice(0, Math.floor(text.length / 2));
            truncated = true;
            bounded = message();
          }
          result = bounded;
        }
        const stored = result.toDict();
        await store.update(taskId, (task) => {
          owned(task, owner);
          const entry = task.tools.find((item) => item.toolCallId === id)!;
          entry.status = "completed";
          entry.result = stored;
          return task;
        });
        return result;
      } catch (error) {
        await store.update(taskId, (task) => {
          owned(task, owner);
          task.tools.find((item) => item.toolCallId === id)!.status = isGraphInterrupt(error)
            ? "waiting_approval"
            : "uncertain";
          return task;
        });
        throw error;
      }
    },
  });
}
