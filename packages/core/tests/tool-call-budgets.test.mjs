import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ToolMessage } from "@langchain/core/messages";
import { executionMiddleware } from "../src/delegation/execution.ts";
import { MemoryDelegationStore } from "../src/delegation/storage/store.ts";

test("failed attempts consume tool allowance; rebuilding middleware and replaying results never resets it", async () => {
  const store = new MemoryDelegationStore();
  const { task } = await store.claim({
    conversationId: "tool-budget",
    parentExecutionId: "user",
    parentToolCallId: "delegate",
    parentAgentId: "orchestrator",
    request: { agentId: "researcher", objective: "Research", context: "" },
    requestHash: "fixture",
  });
  const owner = randomUUID();
  await store.update(task.taskId, (task) => ({
    ...task,
    ownerToken: owner,
    leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
  }));
  let dispatched = 0;
  const handler = async (request) => {
    dispatched++;
    return new ToolMessage({
      name: "search",
      tool_call_id: request.toolCall.id,
      status: "error",
      content: "HTTP 429",
    });
  };
  const invoke = (middleware, id) =>
    middleware.wrapToolCall(
      { tool: { name: "search" }, toolCall: { id, name: "search", args: { text: "query" } } },
      handler,
    );
  try {
    const first = executionMiddleware(store, task.taskId, owner, 8, { search: 1 });
    assert.equal((await invoke(first, "first")).status, "error");
    const restored = executionMiddleware(store, task.taskId, owner, 8, { search: 1 });
    assert.match((await invoke(restored, "first")).text, /429/);
    assert.match((await invoke(restored, "second")).text, /not dispatched/);
    assert.match((await invoke(restored, "second")).text, /not dispatched/);
    assert.equal(dispatched, 1);
    const persisted = await store.get(task.taskId);
    assert.equal(persisted.tools.length, 2);
    assert(persisted.tools.every((entry) => entry.status === "completed"));
  } finally {
    await store.close();
  }
});
