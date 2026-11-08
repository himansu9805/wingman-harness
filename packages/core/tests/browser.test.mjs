import assert from "node:assert/strict";
import { test } from "node:test";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { BrowserTools } from "../src/integrations/browser/tools.ts";
import { responseTool } from "../src/integrations/mcp/tool.ts";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn, resumeTurn } from "../src/conversations/turn.ts";

function fixture() {
  const calls = [];
  let rejectClose = false;
  const native = ["agent_browser_open", "agent_browser_snapshot", "agent_browser_close"].map(
    (name) =>
      responseTool(
        tool(async () => "unused", {
          name: `mcp__agent__browser__agent-browser__${name}`,
          description: name,
          schema: z.record(z.string(), z.unknown()),
        }),
        async (args, signal) => {
          calls.push({ name, args, signal });
          return {
            isError: rejectClose && name === "agent_browser_close",
            content: [
              { type: "text", text: name === "agent_browser_snapshot" ? "Observed heading" : "ok" },
            ],
          };
        },
      ),
  );
  const provider = new BrowserTools({ getTools: async () => native }, "browser");
  const invoke = (name, args, thread = "checkpoint-a", signal) => {
    const selected = provider.tools.find((tool) => tool.name === name);
    return selected.invoke(
      { type: "tool_call", id: `call-${calls.length}`, name, args },
      { configurable: { thread_id: thread }, signal },
    );
  };
  return {
    provider,
    calls,
    invoke,
    setRejectClose(value) {
      rejectClose = value;
    },
  };
}

test("browser sessions are derived from trusted executions and reused only within that execution", async () => {
  const f = fixture();
  await f.invoke("browser_open", { url: "https://example.com" });
  await f.invoke("browser_snapshot", {});
  await f.invoke("browser_open", { url: "https://example.org" }, "checkpoint-b");
  assert.match(f.calls[0].args.session, /^wingman-[a-f0-9]{32}$/);
  assert.equal(f.calls[0].args.session, f.calls[1].args.session);
  assert.notEqual(f.calls[0].args.session, f.calls[2].args.session);
  assert.equal(f.calls[1].args.depth, 4);
  await f.provider.close();
});

test("the browser's typed interface rejects host, session, domain and CLI overrides before dispatch", async () => {
  const f = fixture();
  for (const args of [
    { url: "https://example.com", session: "foreign" },
    { url: "https://example.com", allowedDomains: ["example.com"] },
    { url: "https://example.com", extraArgs: ["--config", "other"] },
    { url: "file:///etc/passwd" },
  ])
    await assert.rejects(f.invoke("browser_open", args));
  assert.equal(f.calls.length, 0);
});

test("cleanup is execution-scoped, idempotent, and independent of request cancellation", async () => {
  const f = fixture();
  await f.invoke("browser_open", { url: "https://example.com" });
  await f.provider.release("checkpoint-b");
  assert.equal(f.calls.length, 1);
  await f.provider.release("checkpoint-a");
  const close = f.calls.at(-1);
  assert.equal(close.name, "agent_browser_close");
  assert.equal(close.args.session, f.calls[0].args.session);
  assert(close.signal instanceof AbortSignal);
  assert.equal(close.signal.aborted, false);
  await f.provider.release("checkpoint-a");
  assert.equal(f.calls.length, 2);
});

test("failed cleanup retains ownership so it can be retried without touching another execution", async () => {
  const f = fixture();
  await f.invoke("browser_open", { url: "https://example.com" });
  f.setRejectClose(true);
  await assert.rejects(f.provider.release("checkpoint-a"), /cleanup failed/);
  f.setRejectClose(false);
  await f.provider.release("checkpoint-a");
  assert.equal(f.calls.filter((call) => call.name === "agent_browser_close").length, 2);
});

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
    args: { agentId: "operator", objective: "Inspect uptime", context: "" },
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
