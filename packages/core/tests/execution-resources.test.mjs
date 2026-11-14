import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn, resumeTurn } from "../src/conversations/turn.ts";

test("runtime releases completed and failed worker resources automatically", async () => {
  for (const fail of [false, true]) {
    const released = [];
    let closed = 0;
    const f = await createDelegationRuntime({
      executionResources: [
        {
          release: async (id) => released.push(id),
          close: async () => {
            closed++;
          },
        },
      ],
      child: async () => {
        if (fail) throw new Error("provider failure");
        return "Finished";
      },
    });
    try {
      await startTurn(f.agent, "delegate", "managed-worker", {
        signal: AbortSignal.timeout(10000),
      });
      const [task] = await f.store.listConversation("managed-worker");
      assert.deepEqual(released, [task.checkpointThreadId]);
    } finally {
      await f.runtime.close();
    }
    assert.equal(closed, 1);
  }
});

test("approval pauses retain worker resources until completion or cancellation", async () => {
  const released = [];
  const { ToolMessage } = await import("@langchain/core/messages");
  const f = await createDelegationRuntime({
    args: { agentId: "coder", objective: "Inspect uptime", context: "" },
    executionResources: [{ release: async (id) => released.push(id), close: async () => {} }],
    child: async (messages) =>
      messages.some(ToolMessage.isInstance)
        ? "Finished"
        : [
            {
              type: "tool_call",
              id: "uptime",
              name: "exec_bash_command",
              args: { command: "uptime" },
            },
          ],
  });
  try {
    const paused = await startTurn(f.agent, "delegate", "paused-worker", {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(paused.kind, "paused");
    assert.deepEqual(released, []);
    await resumeTurn(f.agent, { [paused.approvals[0].id]: false }, "paused-worker", {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(released.length, 1);
  } finally {
    await f.runtime.close();
  }
});
