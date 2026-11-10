import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { turnContent } from "../src/features/chat/model/turn-content.ts";
import { applyEvent, emptyActivity } from "../src/features/chat/model/events.ts";
import { AssistantTurn } from "../src/features/chat/components/AssistantTurn.tsx";

const memory = { id: "memory", name: "recall_memory", args: { name: "User" } };
const delegate = { id: "delegate", name: "delegate_task", args: {} };
const skill = { id: "skill", name: "load_skill", args: { name: "writing" } };
const plan = {
  type: "delegation_plan",
  runId: "run",
  planId: "plan",
  parentToolCallId: "delegate",
  parentExecutionId: "user",
  conversationId: "chat",
  status: "completed",
  tasks: [],
  startedAt: "2026-11-09T00:00:00Z",
  finishedAt: "2026-11-09T00:00:01Z",
  asOf: "2026-11-09T00:00:01Z",
  elapsedMs: 1000,
  error: null,
};
const event = (call) => ({
  type: "tool_call",
  runId: "run",
  name: call.name,
  args: call.args,
  toolCallId: call.id,
});
const saved = (id, calls = [], text = "") => ({ id, role: "assistant", toolCalls: calls, text });
const events = [
  event(memory),
  event(delegate),
  { ...plan, status: "running" },
  event(skill),
  plan,
].reduce(applyEvent, emptyActivity).events;
const order = (content) =>
  content.flatMap((item) =>
    item.type === "tools" ? item.calls.map((call) => call.id) : [item.type],
  );

for (const [name, messages] of [
  ["live", []],
  ["partially saved", [saved("before", [memory])]],
  [
    "saved",
    [
      saved("before", [memory]),
      saved("delegation", [delegate]),
      saved("after", [skill]),
      saved("reply", [], "Final response"),
    ],
  ],
]) {
  test(`${name} tool activity surrounds delegation in execution order without replay duplicates`, () => {
    const turn = { id: "user", messages, events };
    const content = turnContent(turn);
    assert.deepEqual(order(content), [
      "memory",
      "delegation",
      "skill",
      ...(name === "saved" ? ["text"] : []),
    ]);
    assert.equal(content.find((item) => item.type === "delegation").plan.status, "completed");
    const html = renderToStaticMarkup(
      createElement(AssistantTurn, {
        turn,
        current: true,
        model: { activity: { phase: "done" }, pending: [], loading: false, working: false },
      }),
    );
    assert(html.indexOf("Recall memory") < html.indexOf("Delegated work"));
    assert(html.indexOf("Delegated work") < html.indexOf("Load skill"));
    assert.equal((html.match(/Delegated work/g) ?? []).length, 1);
    if (name === "saved") assert(html.indexOf("Load skill") < html.indexOf("Final response"));
  });
}

test("a saved final answer follows live activity when its tool history has not refreshed", () => {
  const turn = { id: "user", messages: [saved("reply", [], "Final response")], events };
  assert.deepEqual(order(turnContent(turn)), ["memory", "delegation", "skill", "text"]);
});

test("plan snapshots supply a card when its parent call is outside the retained journal", () => {
  const turn = { id: "user", messages: [], events: [event(memory), plan, event(skill)] };
  assert.deepEqual(order(turnContent(turn)), ["memory", "delegation", "skill"]);
});

test("saved commentary and tools retain their order without delegation", () => {
  const turn = {
    id: "user",
    events: [],
    messages: [
      saved("before", [], "Checking memory"),
      saved("call", [memory], "Found context"),
      saved("reply", [], "Final response"),
    ],
  };
  assert.deepEqual(order(turnContent(turn)), ["text", "memory", "text", "text"]);
});

test("earlier live calls precede a saved delegation when history only contains part of the turn", () => {
  const turn = {
    id: "user",
    events,
    messages: [saved("delegation", [delegate]), saved("after", [skill])],
  };
  assert.deepEqual(order(turnContent(turn)), ["memory", "delegation", "skill"]);
});

test("live delegation splits a saved tool group at its execution position", () => {
  const turn = { id: "user", events, messages: [saved("calls", [memory, skill])] };
  assert.deepEqual(order(turnContent(turn)), ["memory", "delegation", "skill"]);
});
