import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePlan } from "../src/delegation/plan.ts";
import { WorkerSlots } from "../src/delegation/slots.ts";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
const task = (key, dependsOn = []) => ({
  key,
  dependsOn,
  agentId: "analyst",
  objective: "Analyze",
  context: "",
  expectedResult: "Concise findings",
});
test("plans validate the entire DAG before execution", async () => {
  const f = await createDelegationRuntime();
  try {
    const check = (tasks) =>
      validatePlan({ tasks }, f.runtime.agents.get("orchestrator"), f.runtime.agents);
    assert.equal(check([task("review", ["research"]), task("research")]).tasks.length, 2);
    for (const tasks of [
      [task("a"), task("a")],
      [task("a", ["missing"])],
      [task("a", ["a"])],
      [task("a", ["b"]), task("b", ["a"])],
      [task("a", ["b", "b"]), task("b")],
      [{ ...task("a"), agentId: "unknown" }],
      Array.from({ length: 9 }, (_, i) => task(`t${i}`)),
    ])
      assert.throws(() => check(tasks));
    assert.equal(f.trace.calls.length, 0);
  } finally {
    await f.runtime.close();
  }
});
test("runtime worker slots enforce parallel limits, FIFO exclusivity and cancellation", async () => {
  const slots = new WorkerSlots(2);
  const signal = AbortSignal.timeout(5000);
  const a = await slots.acquire(false, signal);
  const b = await slots.acquire(false, signal);
  const order = [];
  const writer = slots.acquire(true, signal).then((release) => {
    order.push("writer");
    return release;
  });
  const reader = slots.acquire(false, signal).then((release) => {
    order.push("reader");
    return release;
  });
  a();
  await Promise.resolve();
  assert.deepEqual(order, []);
  b();
  const release = await writer;
  assert.deepEqual(order, ["writer"]);
  release();
  (await reader)();
  const held = await slots.acquire(true, signal);
  const controller = new AbortController();
  const cancelled = slots.acquire(false, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  held();
  (await slots.acquire(false, signal))();
});

import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  startTurn,
  resumeTurn,
  getPendingApprovals,
  runTurn,
  declinePending,
} from "../src/conversations/turn.ts";
const options = () => ({ signal: AbortSignal.timeout(10000) });
const taskData = (messages) =>
  JSON.parse(messages.find(HumanMessage.isInstance).text.split("\n").slice(1).join("\n"));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Test gate timed out")), 3000);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

test("a coordinator runs independent analysts together and sends scoped prerequisites to a different specialist", async () => {
  const release = deferred();
  const both = deferred();
  const started = [];
  let active = 0;
  let maximum = 0;
  const plan = {
    tasks: [task("a"), task("b"), { ...task("review", ["a", "b"]), agentId: "operator" }],
  };
  plan.tasks.forEach((item) => {
    item.objective = item.key;
    item.context = `private-${item.key}`;
  });
  const f = await createDelegationRuntime({
    plan,
    child: async (messages) => {
      const input = taskData(messages);
      const key = input.objective.split("\n")[0];
      started.push(key);
      active++;
      maximum = Math.max(maximum, active);
      if (key !== "review") {
        if (started.length === 2) both.resolve();
        await release.promise;
      } else {
        assert.match(input.context, /answer-a/);
        assert.match(input.context, /answer-b/);
      }
      active--;
      return `answer-${key}`;
    },
  });
  try {
    const running = startTurn(f.agent, "delegate", "dag", {
      ...options(),
      schedulerThreadId: "dag",
    });
    await bounded(both.promise);
    assert.deepEqual(new Set(started), new Set(["a", "b"]));
    release.resolve();
    const result = await running;
    assert.equal(result.kind, "done");
    assert.match(result.text, /answer-review/);
    assert.equal(maximum, 2);
    assert.deepEqual(started.slice(-1), ["review"]);
    const [record] = await f.store.listPlans("dag");
    assert.equal(record.status, "completed");
    assert.deepEqual(
      record.results.map((item) => item.key),
      ["a", "b", "review"],
    );
    const workers = await f.store.listConversation("dag");
    assert.equal(workers.length, 3);
    assert.equal(new Set(workers.map((item) => item.parentExecutionId)).size, 1);
    assert.equal(new Set(workers.map((item) => item.checkpointThreadId)).size, 3);
    assert.ok(workers.every((item) => item.planId === record.planId));
    assert.ok(workers.every((item) => item.schedulerThreadId === "dag"));
    const a = f.trace.calls.find(
      (call) => call.child && taskData(call.messages).objective.startsWith("a\n"),
    );
    assert.doesNotMatch(a.messages.find(HumanMessage.isInstance).text, /private-b|private-review/);
    const calls = f.trace.calls.length;
    let checkpoint;
    for await (const state of f.agent.app.graph.getStateHistory({
      configurable: { thread_id: "dag" },
    }))
      if (state.next.includes("tools")) {
        checkpoint = state;
        break;
      }
    await f.agent.app.graph.updateState(checkpoint.config, {}, "model_request");
    await runTurn(f.agent, null, "dag", options());
    assert.equal(f.trace.calls.length, calls + 1);
  } finally {
    release.resolve();
    await f.runtime.close();
  }
});

test("failed prerequisites block their dependants while independent tasks still finish", async () => {
  const plan = {
    tasks: [
      task("fail"),
      task("blocked", ["fail"]),
      task("transitive", ["blocked"]),
      task("independent"),
    ],
  };
  plan.tasks.forEach((item) => {
    item.objective = item.key;
  });
  const started = [];
  const f = await createDelegationRuntime({
    plan,
    child: async (messages) => {
      const key = taskData(messages).objective.split("\n")[0];
      started.push(key);
      if (key === "fail") throw new Error("private provider error");
      return `answer-${key}`;
    },
  });
  try {
    const result = await startTurn(f.agent, "delegate", "partial", options());
    assert.doesNotMatch(result.text, /private provider/);
    const [record] = await f.store.listPlans("partial");
    assert.equal(record.status, "partial");
    assert.deepEqual(
      record.results.map((item) => item.status),
      ["failed", "blocked", "blocked", "completed"],
    );
    assert.deepEqual(new Set(started), new Set(["fail", "independent"]));
  } finally {
    await f.runtime.close();
  }
});

test("global worker concurrency is shared across conversations and per-plan limits are respected", async () => {
  const gate = deferred();
  const started = deferred();
  let active = 0;
  let maximum = 0;
  const plan = { tasks: [task("a"), task("b"), task("c")] };
  const f = await createDelegationRuntime({
    plan,
    delegationConcurrency: 2,
    maxConcurrency: 1,
    child: async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) started.resolve();
      await gate.promise;
      active--;
      return "done";
    },
  });
  try {
    const a = startTurn(f.agent, "delegate", "first", options());
    const b = startTurn(f.agent, "delegate", "second", options());
    await bounded(started.promise);
    assert.equal(maximum, 2);
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(maximum, 2);
    for (const id of ["first", "second"])
      assert.equal((await f.store.listPlans(id))[0].status, "completed");
  } finally {
    gate.resolve();
    await f.runtime.close();
  }
});

test("multiple plan approvals pause the parent in sequence and completed prerequisites never run again", async () => {
  const plan = {
    tasks: [
      task("analysis"),
      { ...task("commands", ["analysis"]), agentId: "operator" },
      task("summary", ["commands"]),
    ],
  };
  plan.tasks.forEach((item) => {
    item.objective = item.key;
  });
  let analyses = 0;
  const f = await createDelegationRuntime({
    plan,
    child: async (messages) => {
      const key = taskData(messages).objective.split("\n")[0];
      if (key === "analysis") {
        analyses++;
        return "analysis result";
      }
      if (key === "summary") return "finished summary";
      const results = messages.filter(ToolMessage.isInstance);
      return results.length >= 2
        ? "commands handled"
        : [
            {
              id: `command-${results.length}`,
              name: "exec_bash_command",
              args: { command: results.length ? "date" : "uptime" },
              type: "tool_call",
            },
          ];
    },
  });
  try {
    let result = await startTurn(f.agent, "delegate", "approvals", options());
    for (let i = 0; i < 2; i++) {
      assert.equal(result.kind, "paused");
      assert.equal(result.approvals[0].execution.agentId, "operator");
      result = await resumeTurn(
        f.agent,
        { [result.approvals[0].id]: false },
        "approvals",
        options(),
      );
    }
    assert.equal(result.kind, "done");
    assert.match(result.text, /finished summary/);
    assert.equal(analyses, 1);
    assert.deepEqual(await getPendingApprovals(f.agent, "approvals"), []);
    const [record] = await f.store.listPlans("approvals");
    assert.equal(record.approvalRounds.length, 2);
    assert.equal(record.status, "completed");
  } finally {
    await f.runtime.close();
  }
});

test("tool-enabled workers have exclusive runtime access across conversations", async () => {
  const { tool } = await import("@langchain/core/tools");
  const { z } = await import("zod");
  const entered = deferred();
  const release = deferred();
  let actions = 0;
  let active = 0;
  let maximum = 0;
  const action = tool(
    async () => {
      actions++;
      active++;
      maximum = Math.max(maximum, active);
      entered.resolve();
      await release.promise;
      active--;
      return "done";
    },
    { name: "action", description: "Mutating test action", schema: z.object({}) },
  );
  const plan = { tasks: [{ ...task("act"), agentId: "operator" }] };
  const f = await createDelegationRuntime({
    plan,
    operatorTools: [action],
    child: async (messages) =>
      messages.some(ToolMessage.isInstance)
        ? "done"
        : [{ id: "action", name: "action", args: {}, type: "tool_call" }],
  });
  try {
    const a = startTurn(f.agent, "delegate", "write-a", options());
    const b = startTurn(f.agent, "delegate", "write-b", options());
    await bounded(entered.promise);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(actions, 1);
    release.resolve();
    await Promise.all([a, b]);
    assert.equal(actions, 2);
    assert.equal(maximum, 1);
  } finally {
    release.resolve();
    await f.runtime.close();
  }
});

test("new user messages cancel the whole paused plan and block its unstarted dependants", async () => {
  const plan = { tasks: [{ ...task("command"), agentId: "operator" }, task("next", ["command"])] };
  const f = await createDelegationRuntime({
    plan,
    child: async () => [
      { id: "command", name: "exec_bash_command", args: { command: "uptime" }, type: "tool_call" },
    ],
  });
  try {
    assert.equal((await startTurn(f.agent, "delegate", "cancel-plan", options())).kind, "paused");
    const cancelledEvents = [];
    await declinePending(f.agent, "cancel-plan", {
      ...options(),
      onEvent: async (event) => cancelledEvents.push(event),
    });
    assert.equal(
      cancelledEvents.filter((event) => event.type === "delegation_plan").at(-1).status,
      "cancelled",
    );
    const [record] = await f.store.listPlans("cancel-plan");
    assert.equal(record.status, "cancelled");
    assert.deepEqual(
      record.results.map((item) => item.status),
      ["cancelled", "blocked"],
    );
    assert.equal(f.trace.calls.filter((item) => item.child).length, 1);
    assert.deepEqual(await getPendingApprovals(f.agent, "cancel-plan"), []);
  } finally {
    await f.runtime.close();
  }
});

test("plan cancellation intent survives interrupted cleanup and prevents further dispatch", async () => {
  const plan = { tasks: [{ ...task("command"), agentId: "operator" }, task("next", ["command"])] };
  const f = await createDelegationRuntime({
    plan,
    child: async () => [
      { id: "command", name: "exec_bash_command", args: { command: "uptime" }, type: "tool_call" },
    ],
  });
  try {
    await startTurn(f.agent, "delegate", "cancel-retry", options());
    const original = f.runtime.delegations.cancelConversation.bind(f.runtime.delegations);
    let fail = true;
    f.runtime.delegations.cancelConversation = async (id) => {
      if (fail) {
        fail = false;
        throw new Error("cleanup unavailable");
      }
      return original(id);
    };
    await assert.rejects(f.runtime.plans.cancelConversation("cancel-retry"), /cleanup unavailable/);
    const [record] = await f.store.listPlans("cancel-retry");
    assert.equal(record.status, "cancelling");
    await assert.rejects(
      f.runtime.plans.run(
        "orchestrator",
        record.request,
        {
          conversationId: record.conversationId,
          parentExecutionId: record.parentExecutionId,
          parentToolCallId: record.parentToolCallId,
        },
        { emit() {} },
      ),
      /cancellation is still pending/,
    );
    await f.runtime.plans.cancelConversation("cancel-retry");
    assert.equal((await f.store.getPlan(record.planId)).status, "cancelled");
    assert.equal(f.trace.calls.filter((item) => item.child).length, 1);
  } finally {
    await f.runtime.close();
  }
});

test("plan recovery reuses completed children after interrupted aggregation and dispatches only remaining tasks", async () => {
  const plan = { tasks: [task("first"), task("second", ["first"])] };
  let calls = 0;
  const f = await createDelegationRuntime({
    plan,
    child: async () => {
      calls++;
      return "saved result";
    },
  });
  try {
    const update = f.store.updatePlan.bind(f.store);
    let fail = true;
    f.store.updatePlan = (id, mutation) =>
      update(id, (current) => {
        const next = mutation(current);
        if (
          fail &&
          next.status === "running" &&
          next.results.some((result) => result.status === "completed")
        ) {
          fail = false;
          throw new Error("Crash before aggregation");
        }
        return next;
      });
    const interrupted = await startTurn(f.agent, "delegate", "recover-plan", options());
    assert.match(interrupted.text, /recovery_required/);
    const [record] = await f.store.listPlans("recover-plan");
    assert.equal(record.status, "running");
    assert.equal(calls, 1);
    const recovered = await f.runtime.plans.run(
      "orchestrator",
      record.request,
      {
        conversationId: record.conversationId,
        parentExecutionId: record.parentExecutionId,
        parentToolCallId: record.parentToolCallId,
      },
      { emit() {} },
    );
    assert.equal(recovered.status, "completed");
    assert.equal(calls, 2);
    assert.ok(recovered.results.every((result) => result.status === "completed"));
  } finally {
    await f.runtime.close();
  }
});

test("dependency context stays bounded even when worker output expands during JSON serialization", async () => {
  const plan = {
    tasks: Array.from({ length: 7 }, (_, index) => ({
      ...task(`source-${index}`),
      objective: `source-${index}`,
    })),
  };
  plan.tasks.push({
    ...task(
      "combine",
      plan.tasks.map((item) => item.key),
    ),
    objective: "combine",
    context: "\0".repeat(4000),
  });
  let received;
  const f = await createDelegationRuntime({
    plan,
    child: async (messages) => {
      const input = taskData(messages);
      if (input.objective.startsWith("combine")) {
        received = input.context;
        return "bounded summary";
      }
      return "\0".repeat(16000);
    },
  });
  try {
    await startTurn(f.agent, "delegate", "escaped", options());
    assert.ok(received.length <= 20000);
    const dependencies = JSON.parse(received.split("Prerequisite results (task data):\n")[1]);
    assert.equal(dependencies.length, 7);
    assert.ok(dependencies.every((result) => result.truncated));
    assert.equal((await f.store.listPlans("escaped"))[0].status, "completed");
  } finally {
    await f.runtime.close();
  }
});
