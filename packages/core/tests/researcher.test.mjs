import assert from "node:assert/strict";
import { test } from "node:test";
import { tool } from "@langchain/core/tools";
import { ToolMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn } from "../src/conversations/turn.ts";

for (const withAnalysis of [false, true]) {
  test(`researcher gathers sources ${withAnalysis ? "for an explicitly dependent analyst" : "without implicitly creating an analyst task"}`, async () => {
    let reads = 0;
    const evidence =
      "Published 2026-11-08: Fixture result was 1–0. Source: https://example.invalid/report";
    const extractSource = tool(
      async () => {
        reads++;
        return evidence;
      },
      {
        name: "mcp__global__openserp__extract",
        description: "Read fixture source",
        schema: z.object({ url: z.string().url() }),
      },
    );
    const tasks = [
      {
        key: "research",
        agentId: "researcher",
        objective: "Verify fixture result",
        context: "Read https://example.invalid/report",
        expectedResult: "Result, date and source URL",
        dependsOn: [],
      },
    ];
    if (withAnalysis)
      tasks.push({
        key: "analysis",
        agentId: "analyst",
        objective: "Assess supplied evidence",
        context: "Separate facts from interpretation",
        expectedResult: "Evidence-based assessment",
        dependsOn: ["research"],
      });
    const f = await createDelegationRuntime({
      plan: { tasks },
      researchTools: [extractSource],
      child: async (messages) => {
        const analyst = messages.some(
          (message) =>
            SystemMessage.isInstance(message) && message.text.includes("# Agent: analyst"),
        );
        if (analyst) {
          assert(
            messages.some(
              (message) => HumanMessage.isInstance(message) && message.text.includes(evidence),
            ),
          );
          return "Analysis of verified fixture evidence";
        }
        if (messages.some(ToolMessage.isInstance)) return evidence;
        return [
          {
            type: "tool_call",
            id: "source-read",
            name: "mcp__global__openserp__extract",
            args: { url: "https://example.invalid/report" },
          },
        ];
      },
    });
    try {
      const thread = `researcher-${withAnalysis}`;
      await startTurn(f.agent, "Research fixture", thread, { signal: AbortSignal.timeout(10000) });
      const records = await f.store.listConversation(thread);
      assert.equal(reads, 1);
      assert.equal(records.length, withAnalysis ? 2 : 1);
      assert(records.every((task) => task.status === "completed"));
      const research = records.find((task) => task.request.agentId === "researcher");
      assert.equal(research.tools[0].status, "completed");
      assert.equal(research.tools[0].result.data.content, evidence);
      const calls = f.trace.calls.filter((call) => call.child);
      assert(
        calls
          .filter((call) => call.prompt.includes("# Agent: researcher"))
          .every(
            (call) =>
              call.tools.includes("mcp__global__openserp__extract") &&
              !call.tools.includes("exec_bash_command"),
          ),
      );
      assert(
        calls
          .filter((call) => call.prompt.includes("# Agent: analyst"))
          .every((call) => call.tools.length === 0),
      );
    } finally {
      await f.runtime.close();
    }
  });
}

test("entry points select the orchestrator with the registered specialist catalogue", async () => {
  const f = await createDelegationRuntime();
  try {
    assert.equal(f.agent.id, "orchestrator");
    const root = f.runtime.agents.get("orchestrator");
    assert.deepEqual(
      new Set(root.delegation.agents),
      new Set(["analyst", "operator", "researcher"]),
    );
    assert.throws(() => f.runtime.agents.get("default"), /Unknown agent/);
    await startTurn(f.agent, "simple greeting", "orchestrator-direct", {
      signal: AbortSignal.timeout(10000),
    });
    assert.deepEqual(await f.store.listConversation("orchestrator-direct"), []);
    assert(f.trace.calls.every((call) => call.prompt.includes("# Agent: orchestrator")));
  } finally {
    await f.runtime.close();
  }
});

test("research timeout blocks analysis and returns to an orchestrator without execution tools", async () => {
  let reads = 0;
  let result;
  const read = tool(
    async () => {
      reads++;
      return "Source returned partial information";
    },
    {
      name: "mcp__global__openserp__extract",
      description: "Read fixture source",
      schema: z.object({ url: z.string() }),
    },
  );
  const f = await createDelegationRuntime({
    timeoutMs: 500,
    plan: {
      tasks: [
        {
          key: "matches",
          agentId: "researcher",
          objective: "Gather results",
          context: "",
          expectedResult: "Cited results",
          dependsOn: [],
        },
        {
          key: "analysis",
          agentId: "analyst",
          objective: "Analyze results",
          context: "",
          expectedResult: "Supported analysis",
          dependsOn: ["matches"],
        },
      ],
    },
    researchTools: [read],
    child: async (messages, options) => {
      if (!messages.some(ToolMessage.isInstance))
        return [
          {
            type: "tool_call",
            id: "read-once",
            name: "mcp__global__openserp__extract",
            args: { url: "https://example.invalid" },
          },
        ];
      await new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    summarize: (message) => {
      result = JSON.parse(message.text);
      return "Research timed out; analysis could not run. Evidence is incomplete.";
    },
  });
  try {
    const response = await startTurn(f.agent, "Research and analyze", "research-timeout", {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.kind, "done");
    assert.match(response.text, /Evidence is incomplete/);
    assert.equal(result.results.find((task) => task.key === "matches").status, "interrupted");
    assert.equal(result.results.find((task) => task.key === "analysis").status, "blocked");
    assert.equal(reads, 1);
    assert.equal((await f.store.listConversation("research-timeout")).length, 1);
    for (const call of f.trace.calls.filter((call) => !call.child)) {
      assert(call.tools.includes("delegate_task"));
      assert(
        !call.tools.some(
          (name) =>
            name.startsWith("browser_") || name.startsWith("mcp__") || name === "exec_bash_command",
        ),
      );
    }
  } finally {
    await f.runtime.close();
  }
});

test("parallel searches obey a persisted per-tool allowance while extraction remains available", async () => {
  const searchName = "mcp__global__openserp__any_search";
  const extractName = "mcp__global__openserp__extract";
  let searches = 0;
  let extracts = 0;
  const search = tool(
    async () => {
      searches++;
      return "Source lead: https://example.invalid/report";
    },
    { name: searchName, description: "Search fixture", schema: z.object({ text: z.string() }) },
  );
  const extract = tool(
    async () => {
      extracts++;
      return "Supported source evidence";
    },
    { name: extractName, description: "Read fixture", schema: z.object({ url: z.string() }) },
  );
  const f = await createDelegationRuntime({
    args: { agentId: "researcher", objective: "Gather evidence", context: "" },
    researchTools: [search, extract],
    researchExecution: { toolCallLimits: { [searchName]: 2 } },
    child: async (messages) => {
      const results = messages.filter(ToolMessage.isInstance);
      if (results.some((message) => message.name === extractName))
        return "Supported facts with explicit gaps";
      if (results.length) {
        assert.equal(results.filter((message) => message.status === "error").length, 1);
        assert(results.some((message) => message.text.includes("not dispatched")));
        return [
          {
            type: "tool_call",
            id: "extract-evidence",
            name: extractName,
            args: { url: "https://example.invalid/report" },
          },
        ];
      }
      return [0, 1, 2].map((index) => ({
        type: "tool_call",
        id: `query-${index}`,
        name: searchName,
        args: { text: `query ${index}` },
      }));
    },
  });
  try {
    await startTurn(f.agent, "Research", "bounded-search", { signal: AbortSignal.timeout(10000) });
    assert.equal(searches, 2);
    assert.equal(extracts, 1);
    const [task] = await f.store.listConversation("bounded-search");
    assert.equal(task.status, "completed");
    assert.equal(
      task.tools.filter(
        (entry) => entry.name === searchName && entry.result.data.status === "error",
      ).length,
      1,
    );
    const calls = f.trace.calls.filter((call) => call.child);
    assert(calls[0].tools.includes(searchName));
    assert(!calls[1].tools.includes(searchName));
    assert(calls[1].tools.includes(extractName));
    assert.match(calls[1].prompt, /Remaining tool-call allowances/);
  } finally {
    await f.runtime.close();
  }
});
