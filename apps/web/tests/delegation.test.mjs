import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
dom.window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { DelegatedWork } = await import("../src/features/chat/components/DelegatedWork.tsx");
const { ApprovalCard } = await import("../src/features/chat/components/ApprovalCard.tsx");
const { delegatedPlans, taskCalls } = await import("../src/features/chat/model/delegation.ts");
const { applyEvent, emptyActivity } = await import("../src/features/chat/model/events.ts");
const { transcript } = await import("../src/features/chat/model/transcript.ts");
const usage = {
  scope: "agent",
  modelCalls: 1,
  reportedCalls: 1,
  missingCalls: 0,
  availability: "complete",
  inputTokens: 5,
  outputTokens: 2,
  totalTokens: 7,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};
const task = (key, id) => ({
  key,
  taskId: id,
  agentId: "analyst",
  objective: `Analyze ${key}`,
  dependsOn: [],
  status: "completed",
  output: `Findings for ${key}`,
  truncated: false,
  error: null,
  toolCount: 1,
  decisions: [],
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  elapsedMs: 1000,
  processingMs: 900,
  approvalWaitMs: 0,
  usage,
});
const plan = {
  type: "delegation_plan",
  runId: "first",
  planId: "plan",
  parentExecutionId: "user-old",
  parentToolCallId: "delegate",
  conversationId: "chat",
  status: "completed",
  tasks: [task("research", "one"), task("compare", "two")],
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  asOf: "2026-01-01T00:00:01Z",
  elapsedMs: 1000,
  error: null,
};
const activity = (taskId, event) => ({
  type: "agent_activity",
  runId: "first",
  taskId,
  agentId: "analyst",
  event,
});

test("replayed plan snapshots replace older versions and tool IDs stay inside their owning execution", () => {
  const events = [
    plan,
    { ...plan, status: "partial", tasks: [{ ...plan.tasks[0], status: "failed" }, plan.tasks[1]] },
  ];
  assert.equal(delegatedPlans(events).length, 1);
  assert.equal(delegatedPlans(events)[0].status, "partial");
  const state = events.reduce(applyEvent, emptyActivity);
  assert.equal(state.events.filter((item) => item.type === "delegation_plan").length, 1);
  const calls = [
    activity("one", {
      type: "tool_call",
      toolCallId: "shared",
      name: "check",
      args: { name: "one" },
    }),
    activity("two", {
      type: "tool_call",
      toolCallId: "shared",
      name: "check",
      args: { name: "two" },
    }),
    activity("two", {
      type: "tool_result",
      toolCallId: "shared",
      name: "check",
      output: "only two",
      truncated: false,
    }),
  ];
  assert.equal(taskCalls("one", calls)[0].result, undefined);
  assert.equal(taskCalls("two", calls)[0].result.output, "only two");
});
test("old-plan cleanup belongs to its original prompt even when journaled in the next message run", () => {
  const turns = transcript(
    [
      { id: "user-old", role: "user", text: "old" },
      { id: "user-new", role: "user", text: "new" },
      { id: "answer", role: "assistant", text: "new answer" },
    ],
    [
      { ...plan, runId: "new-run", status: "cancelled" },
      { type: "done", runId: "new-run", text: "new answer" },
    ],
  );
  assert.equal(turns[0].events[0].type, "delegation_plan");
  assert.equal(turns[1].events[0].type, "done");
});
test("delegated tasks expand with native buttons, preserve sibling identity and expose task token totals", (t) => {
  t.after(cleanup);
  const view = render(createElement(DelegatedWork, { plan, events: [plan] }));
  assert.match(view.container.textContent, /2 of 2 completed/);
  assert.match(view.container.textContent, /1 s elapsed at last update\./);
  const trigger = view.getByRole("button", { name: /research.*analyst.*Completed/ });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.match(view.container.textContent, /Findings for research/);
  assert.match(view.container.textContent, /7 tokens/);
  const compare = view.getByRole("button", { name: /compare.*analyst.*Completed/ });
  assert.equal(compare.getAttribute("aria-expanded"), "false");
});
test("approvals identify the task and submit exact independent decisions for the current batch", (t) => {
  t.after(cleanup);
  const submitted = [];
  const approvals = ["one", "two"].map((taskId, index) => ({
    id: `approval-${index}`,
    command: `command-${index}`,
    execution: { taskId, agentId: "analyst", toolCallId: `tool-${index}` },
  }));
  const view = render(
    createElement(ApprovalCard, {
      approvals,
      events: [plan],
      busy: false,
      submit: async (answers) => submitted.push(answers),
    }),
  );
  assert.match(view.container.textContent, /research.*analyst.*Command 1/);
  assert.match(view.container.textContent, /compare.*analyst.*Command 2/);
  fireEvent.click(view.getAllByRole("button", { name: "Approve" })[0]);
  fireEvent.click(view.getAllByRole("button", { name: "Deny" })[1]);
  fireEvent.click(view.getByRole("button", { name: "Submit decisions" }));
  assert.deepEqual(submitted, [{ "approval-0": true, "approval-1": false }]);
});
