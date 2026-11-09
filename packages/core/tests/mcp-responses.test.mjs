import assert from "node:assert/strict";
import { test } from "node:test";
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { responseTool } from "../src/integrations/mcp/tool.ts";
import { taskObservations } from "../src/delegation/evidence.ts";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn } from "../src/conversations/turn.ts";

const definition = tool(async () => "unused", {
  name: "browse",
  description: "Test browsing",
  schema: z.object({ url: z.string() }),
});
const invoke = (selected, id = "browse-1") =>
  selected.invoke({
    type: "tool_call",
    id,
    name: "browse",
    args: { url: "https://example.invalid" },
  });

test("explicit MCP errors preserve their status and text without throwing", async () => {
  const selected = responseTool(definition, async () => ({
    isError: true,
    content: [{ type: "text", text: "Domain not allowed" }],
  }));
  const result = await invoke(selected);
  assert(ToolMessage.isInstance(result));
  assert.equal(result.status, "error");
  assert.equal(result.tool_call_id, "browse-1");
  assert.match(result.text, /Domain not allowed/);
});

test("MCP transport exceptions remain exceptions and receive cancellation", async () => {
  const controller = new AbortController();
  const selected = responseTool(definition, async (_args, signal) => {
    assert(signal instanceof AbortSignal);
    throw new Error("Connection lost after dispatch");
  });
  await assert.rejects(
    selected.invoke(
      { type: "tool_call", id: "lost", name: "browse", args: { url: "https://example.invalid" } },
      { signal: controller.signal },
    ),
    /Connection lost/,
  );
});

test("MCP content keeps images and structured-only results usable", async () => {
  const image = responseTool(definition, async () => ({
    content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
  }));
  assert.equal((await invoke(image)).content[0].image_url.url, "data:image/png;base64,aGVsbG8=");
  const structured = responseTool(definition, async () => ({
    content: [],
    structuredContent: { score: "1-0" },
  }));
  assert.match((await invoke(structured)).text, /1-0/);
});

test("MCP audio and resources retain their protocol data without putting binary resources in model text", async () => {
  const response = {
    content: [
      { type: "audio", mimeType: "audio/wav", data: "aGVsbG8=" },
      {
        type: "resource_link",
        name: "Report",
        uri: "https://example.invalid/report",
        description: "Source report",
      },
      {
        type: "resource",
        resource: { uri: "file:///report.txt", mimeType: "text/plain", text: "Verified report" },
      },
      {
        type: "resource",
        resource: {
          uri: "file:///report.bin",
          mimeType: "application/octet-stream",
          blob: "c2VjcmV0",
        },
      },
    ],
    structuredContent: { summary: "Report" },
    _meta: { request: "source" },
  };
  const result = await invoke(responseTool(definition, async () => response));
  assert.equal(result.content[0].type, "audio");
  assert.match(result.text, /Verified report/);
  assert.doesNotMatch(result.text, /c2VjcmV0/);
  assert.deepEqual(result.artifact, response);
});

test("missing tool identity fails before an MCP call is dispatched", async () => {
  let dispatched = false;
  const selected = responseTool(definition, async () => {
    dispatched = true;
    return { content: [] };
  });
  await assert.rejects(selected.invoke({ url: "https://example.invalid" }), /stable tool call ID/);
  assert.equal(dispatched, false);
});

test("evidence is structured, bounded and excludes unresolved tool calls", () => {
  const tools = Array.from({ length: 10 }, (_, index) => ({
    name: "browse",
    toolCallId: `call-${index}`,
    status: "completed",
    requestedUrl: `https://source-${index}.invalid`,
    result: new ToolMessage({
      tool_call_id: `call-${index}`,
      content: "observed ".repeat(1000),
      status: index === 9 ? "error" : "success",
    }).toDict(),
  }));
  tools.push({ name: "unknown", toolCallId: "pending", status: "uncertain", result: null });
  tools[9].toolCallId = `provider-${"id".repeat(100)}`;
  const observations = taskObservations({ tools });
  assert.equal(observations.length, 4);
  assert.equal(observations.at(-1).status, "error");
  assert.equal(observations.at(-1).toolCallId, tools[9].toolCallId);
  assert.equal(observations.at(-1).requestedUrl, "https://source-9.invalid");
  assert(observations.every((item) => item.content.length <= 500 && item.truncated));
  assert.deepEqual(taskObservations({ tools: [] }), []);
});

test("a worker can use an alternative after a returned MCP error", async () => {
  let calls = 0;
  const selected = responseTool(definition, async () =>
    ++calls === 1
      ? { isError: true, content: [{ type: "text", text: "Source unavailable" }] }
      : { content: [{ type: "text", text: "Verified alternative source" }] },
  );
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "Research", context: "" },
    operatorTools: [selected],
    child: async (messages) => {
      const results = messages.filter(ToolMessage.isInstance);
      if (results.length === 2) return results.at(-1).text;
      return [
        {
          type: "tool_call",
          id: `source-${results.length}`,
          name: "browse",
          args: { url: `https://source-${results.length}.invalid` },
        },
      ];
    },
  });
  try {
    await startTurn(f.agent, "research", "mcp-fallback", { signal: AbortSignal.timeout(10000) });
    const [task] = await f.store.listConversation("mcp-fallback");
    assert.equal(task.status, "completed");
    assert.match(task.output, /Verified alternative/);
    assert.equal(task.tools.length, 2);
    assert.match(task.tools[0].requestedUrl, /source-0/);
    assert(task.tools.every((entry) => entry.status === "completed"));
  } finally {
    await f.runtime.close();
  }
});

test("known pre-dispatch argument validation errors do not become uncertain execution", async () => {
  let dispatched = 0;
  const selected = responseTool(definition, async () => {
    dispatched++;
    return { content: [{ type: "text", text: "Page inspected" }] };
  });
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "Inspect page", context: "" },
    operatorTools: [selected],
    child: async (messages) => {
      const results = messages.filter(ToolMessage.isInstance);
      if (results.length === 2) return results.at(-1).text;
      return [
        {
          type: "tool_call",
          id: `validate-${results.length}`,
          name: "browse",
          args: { url: results.length ? "https://example.invalid" : 42 },
        },
      ];
    },
  });
  try {
    await startTurn(f.agent, "research", "validated-research", {
      signal: AbortSignal.timeout(10000),
    });
    const [task] = await f.store.listConversation("validated-research");
    assert.equal(task.status, "completed");
    assert.equal(dispatched, 1);
    assert.equal(taskObservations(task)[0].status, "error");
  } finally {
    await f.runtime.close();
  }
});

test("model failure after a successful tool retains observations for the coordinator", async () => {
  const selected = responseTool(definition, async () => ({
    content: [{ type: "text", text: "Observed page at https://example.invalid: no match records" }],
  }));
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "Research", context: "" },
    operatorTools: [selected],
    child: async (messages) => {
      if (messages.some(ToolMessage.isInstance)) throw new Error("private provider failure");
      return [
        {
          type: "tool_call",
          id: "source",
          name: "browse",
          args: { url: "https://example.invalid" },
        },
      ];
    },
  });
  try {
    const result = await startTurn(f.agent, "research", "partial-research", {
      signal: AbortSignal.timeout(10000),
    });
    const [task] = await f.store.listConversation("partial-research");
    assert.equal(task.status, "failed");
    assert.equal(task.output, null);
    assert.match(taskObservations(task)[0].content, /Observed page/);
    assert.match(result.text, /Observed page/);
    assert.doesNotMatch(result.text, /private provider/);
  } finally {
    await f.runtime.close();
  }
});

test("lost transport preserves earlier evidence without replaying the uncertain call", async () => {
  let calls = 0;
  const selected = responseTool(definition, async () => {
    if (++calls === 2) throw new Error("Disconnected after dispatch");
    return { content: [{ type: "text", text: "First page was inspected" }] };
  });
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "Research", context: "" },
    operatorTools: [selected],
    child: async (messages) => [
      {
        type: "tool_call",
        id: `page-${messages.filter(ToolMessage.isInstance).length}`,
        name: "browse",
        args: { url: "https://example.invalid" },
      },
    ],
  });
  try {
    const result = await startTurn(f.agent, "research", "partial-transport", {
      signal: AbortSignal.timeout(10000),
    });
    const [task] = await f.store.listConversation("partial-transport");
    assert.equal(task.status, "recovery_required");
    assert.equal(calls, 2);
    assert.match(result.text, /First page was inspected/);
    assert.equal(task.output, null);
    assert.equal(taskObservations(task).length, 1);
    assert.equal(task.tools[1].status, "uncertain");
  } finally {
    await f.runtime.close();
  }
});

test("oversized protocol artifacts preserve readable text within the durable result bound", async () => {
  const source = 'Reported result: "1–0".\n'.repeat(400);
  const selected = tool(
    async () =>
      new ToolMessage({
        name: "read_source",
        tool_call_id: "large-source",
        content: source,
        artifact: { binary: "x".repeat(100000) },
      }),
    { name: "read_source", description: "Read fixture source", schema: z.object({}) },
  );
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "Read source", context: "" },
    operatorTools: [selected],
    child: async (messages) =>
      messages.some(ToolMessage.isInstance)
        ? "Read source"
        : [{ type: "tool_call", id: "large-source", name: "read_source", args: {} }],
  });
  try {
    await startTurn(f.agent, "read", "large-protocol-result", {
      signal: AbortSignal.timeout(10000),
    });
    const [task] = await f.store.listConversation("large-protocol-result");
    assert.equal(task.status, "completed");
    const stored = task.tools[0].result;
    assert.equal(stored.data.content, source);
    assert.deepEqual(stored.data.artifact, { omitted: true });
    assert(JSON.stringify(stored).length <= 64000);
  } finally {
    await f.runtime.close();
  }
});
