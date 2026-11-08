import assert from "node:assert/strict";
import { test } from "node:test";
import { planSnapshot } from "../src/delegation/observation.ts";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn, resumeTurn } from "../src/conversations/turn.ts";
import { ToolMessage } from "@langchain/core/messages";
const task = (key, dependsOn = []) => ({
  key,
  dependsOn,
  agentId: "analyst",
  objective: key,
  context: "",
  expectedResult: "findings",
});
const options = () => ({ signal: AbortSignal.timeout(10000) });

test("complete plan snapshots contain ordered tasks, bounded results and per-child usage without summing parallel duration", async () => {
  const f = await createDelegationRuntime({
    plan: { tasks: [task("a"), task("b")] },
    child: async () => "x".repeat(5000),
  });
  const events = [];
  const counts = [];
  try {
    await startTurn(f.agent, "delegate", "observed", {
      ...options(),
      onEvent: async (event) => events.push(event),
      onModelUsage: async (usage, _id, source) => counts.push({ usage, source }),
    });
    const snapshots = events.filter((event) => event.type === "delegation_plan");
    assert.ok(snapshots.length > 2);
    assert.ok(snapshots[0].tasks.every((task) => task.status === "pending"));
    const final = snapshots.at(-1);
    assert.equal(final.status, "completed");
    assert.deepEqual(
      final.tasks.map((task) => task.key),
      ["a", "b"],
    );
    assert.ok(
      final.tasks.every(
        (task) => task.output.length === 4000 && task.truncated && task.usage.totalTokens === 7,
      ),
    );
    assert.equal(counts.length, 4);
    assert.equal(counts.filter((item) => item.source?.taskId).length, 2);
    assert.equal(
      counts.reduce((sum, item) => sum + item.usage.totalTokens, 0),
      28,
    );
    const [plan] = await f.store.listPlans("observed");
    const tasks = await f.store.listPlanTasks(plan.planId);
    const now = Date.now();
    plan.startedAt = new Date(now - 1000).toISOString();
    plan.finishedAt = new Date(now).toISOString();
    for (const task of tasks) task.processingMs = 900;
    const snapshot = planSnapshot(plan, tasks, now);
    assert.equal(snapshot.elapsedMs, 1000);
    assert.equal(
      snapshot.tasks.reduce((sum, item) => sum + item.processingMs, 0),
      1800,
    );
  } finally {
    await f.runtime.close();
  }
});

test("approval resume snapshots reuse task identities and prior usage while exposing current wait time", async () => {
  const f = await createDelegationRuntime({
    args: { agentId: "operator", objective: "inspect", context: "" },
    child: async (messages) =>
      messages.some(ToolMessage.isInstance)
        ? "declined"
        : [
            {
              id: "cmd",
              name: "exec_bash_command",
              args: { command: "uptime" },
              type: "tool_call",
            },
          ],
  });
  try {
    const events = [];
    const paused = await startTurn(f.agent, "delegate", "paused", {
      ...options(),
      onEvent: async (event) => events.push(event),
    });
    const snapshot = events.filter((event) => event.type === "delegation_plan").at(-1);
    assert.equal(snapshot.status, "waiting_approval");
    assert.equal(snapshot.tasks[0].usage.modelCalls, 1);
    const [plan] = await f.store.listPlans("paused");
    const tasks = await f.store.listPlanTasks(plan.planId);
    const now = Date.now();
    tasks[0].pausedAt = new Date(now - 60000).toISOString();
    const waiting = planSnapshot(plan, tasks, now);
    assert.ok(waiting.tasks[0].approvalWaitMs >= 60000);
    assert.equal(waiting.tasks[0].processingMs, tasks[0].processingMs);
    await resumeTurn(f.agent, { [paused.approvals[0].id]: false }, "paused", {
      ...options(),
      onEvent: async (event) => events.push(event),
    });
    const final = events.filter((event) => event.type === "delegation_plan").at(-1);
    assert.equal(final.tasks[0].taskId, snapshot.tasks[0].taskId);
    assert.equal(final.tasks[0].usage.modelCalls, 2);
  } finally {
    await f.runtime.close();
  }
});
