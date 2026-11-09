import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import {
  startTurn,
  resumeTurn,
  getPendingApprovals,
  declinePending,
  runTurn,
} from "../src/conversations/turn.ts";
import { Agent } from "../src/agents/agent.ts";
import { DelegationRunner } from "../src/delegation/runner.ts";

const options = () => ({ signal: AbortSignal.timeout(10000) });
const args = { agentId: "operator", objective: "Run approved commands", context: "" };
const child = (commands) => async (messages) => {
  const results = messages.filter(ToolMessage.isInstance);
  return results.length
    ? results.map((message) => message.text).join("\n")
    : commands.map((command, index) => ({
        id: `command-${index}`,
        name: "exec_bash_command",
        args: { command },
        type: "tool_call",
      }));
};

for (const approve of [true, false])
  test(`delegated parallel commands expose owners and ${approve ? "execute" : "decline"} through parent resume`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "wingman-worker-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = [join(directory, "first"), join(directory, "second")];
    const commands = files.map(
      (file) =>
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(file)}, 'once')`)}`,
    );
    const f = await createDelegationRuntime({ args, child: child(commands) });
    try {
      const events = [];
      const paused = await startTurn(f.agent, "delegate", "chat", {
        ...options(),
        onEvent: async (event) => events.push(event),
      });
      assert.equal(paused.kind, "paused");
      const pending = await getPendingApprovals(f.agent, "chat");
      assert.equal(pending.length, 2);
      assert.deepEqual(pending.map((item) => item.command).sort(), commands.sort());
      const [task] = await f.store.listConversation("chat");
      assert.equal(task.status, "waiting_approval");
      assert.equal(task.ownerToken, null);
      assert.equal(task.modelCalls, 1);
      assert.ok(
        pending.every(
          (item) => item.execution.agentId === "operator" && item.execution.taskId === task.taskId,
        ),
      );
      assert.ok(
        events.some((event) => event.type === "agent_activity" && event.event.type === "tool_call"),
      );
      for (const file of files) await assert.rejects(readFile(file), { code: "ENOENT" });
      await assert.rejects(
        resumeTurn(f.agent, { [pending[0].id]: approve }, "chat", options()),
        /every pending/,
      );
      const result = await resumeTurn(
        f.agent,
        Object.fromEntries(pending.map((item) => [item.id, approve])),
        "chat",
        options(),
      );
      assert.equal(result.kind, "done");
      if (!approve) assert.match(result.text, /Declined/);
      for (const file of files) {
        if (approve) assert.equal(await readFile(file, "utf8"), "once");
        else await assert.rejects(readFile(file), { code: "ENOENT" });
      }
      const [completed] = await f.store.listConversation("chat");
      assert.equal(completed.status, "completed");
      assert.equal(completed.modelCalls, 2);
      assert.equal(completed.tools.filter((tool) => tool.status === "completed").length, 2);
      await assert.rejects(
        resumeTurn(
          f.agent,
          Object.fromEntries(pending.map((item) => [item.id, true])),
          "chat",
          options(),
        ),
        /Nothing is waiting/,
      );
      // Rewind only the parent. Its durable task result must bypass the worker.
      let checkpoint;
      for await (const state of f.agent.app.graph.getStateHistory({
        configurable: { thread_id: "chat" },
      })) {
        if (state.next.includes("tools")) {
          checkpoint = state;
          break;
        }
      }
      assert.ok(checkpoint);
      await f.agent.app.graph.updateState(checkpoint.config, {}, "model_request");
      await runTurn(f.agent, null, "chat", options());
      if (approve) for (const file of files) assert.equal(await readFile(file, "utf8"), "once");
    } finally {
      await f.runtime.close();
    }
  });

test("approval waiting survives a new runner and does not reset persisted model budgets", async () => {
  const f = await createDelegationRuntime({ args, maxModelCalls: 1, child: child(["uptime"]) });
  try {
    await startTurn(f.agent, "delegate", "chat", options());
    const [task] = await f.store.listConversation("chat");
    assert.equal(task.status, "waiting_approval");
    const replacement = new DelegationRunner(
      f.runtime.agents,
      f.store,
      (id, middleware) => Agent.create(f.runtime, id, [middleware]),
      (id) => f.saver.deleteThread(id),
    );
    const result = await replacement.resume(
      "orchestrator",
      task.taskId,
      Object.fromEntries(task.pendingApprovals.map((item) => [item.id, false])),
      { emit() {} },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.modelCalls, 1);
    assert.ok(result.approvalWaitMs >= 0);
    assert.equal(result.tools[0].status, "completed");
    await replacement.close();
  } finally {
    await f.runtime.close();
  }
});

test("abandoning a paused parent cancels its worker instead of executing the approved action", async () => {
  const f = await createDelegationRuntime({ args, child: child(["uptime"]) });
  try {
    await startTurn(f.agent, "delegate", "chat", options());
    await declinePending(f.agent, "chat", options());
    assert.equal((await f.store.listConversation("chat"))[0].status, "cancelled");
    assert.deepEqual(await getPendingApprovals(f.agent, "chat"), []);
    assert.equal(f.trace.calls.filter((call) => call.child).length, 1);
    assert.equal(
      (await startTurn(f.agent, "simple new question", "chat", options())).text,
      "Direct response",
    );
  } finally {
    await f.runtime.close();
  }
});

for (const outcome of ["waiting_approval", "completed"])
  test(`expired owner reconciles a saved ${outcome} checkpoint without running the child again`, async () => {
    const f = await createDelegationRuntime({
      args,
      child: outcome === "completed" ? async () => "saved final" : child(["uptime"]),
    });
    try {
      const original = f.store.update.bind(f.store);
      let fail = true;
      f.store.update = (id, mutation) =>
        original(id, (current) => {
          const next = mutation(current);
          if (fail && next.status === outcome) {
            fail = false;
            throw new Error("Simulated crash before task result persisted");
          }
          return next;
        });
      const response = await startTurn(f.agent, "delegate", "crashed", options());
      assert.match(response.text, /recovery_required/);
      assert.doesNotMatch(response.text, /Simulated crash/);
      const [task] = await f.store.listConversation("crashed");
      assert.equal(task.status, "running");
      await original(task.taskId, (current) => ({
        ...current,
        leaseExpiresAt: new Date(0).toISOString(),
      }));
      const calls = f.trace.calls.length;
      const recovered = await f.runtime.delegations.run(
        "orchestrator",
        task.request,
        {
          planId: task.planId,
          planTaskKey: task.planTaskKey,
          conversationId: task.conversationId,
          parentExecutionId: task.parentExecutionId,
          parentToolCallId: task.parentToolCallId,
        },
        { emit() {} },
      );
      assert.equal(recovered.status, outcome);
      assert.equal(f.trace.calls.length, calls);
      if (outcome === "completed") assert.equal(recovered.output, "saved final");
      else assert.equal(recovered.pendingApprovals[0].command, "uptime");
    } finally {
      await f.runtime.close();
    }
  });

test("expired tasks with an uncertain action are never restarted or automatically approved", async () => {
  const f = await createDelegationRuntime({ args });
  try {
    const { createHash, randomUUID } = await import("node:crypto");
    const identity = {
      conversationId: "uncertain",
      parentExecutionId: "user",
      parentToolCallId: "delegate",
    };
    const { task } = await f.store.claim({
      ...identity,
      parentAgentId: "orchestrator",
      request: args,
      requestHash: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    });
    await f.store.update(task.taskId, (current) => ({
      ...current,
      attempt: 1,
      leaseExpiresAt: new Date(0).toISOString(),
      tools: [
        {
          toolCallId: "uncertain-command",
          name: "exec_bash_command",
          hash: "hash",
          ownerToken: randomUUID(),
          status: "running",
          result: null,
        },
      ],
    }));
    const recovered = await f.runtime.delegations.run("orchestrator", args, identity, {
      emit() {},
    });
    assert.equal(recovered.status, "recovery_required");
    assert.equal(f.trace.calls.length, 0);
    const repeated = await f.runtime.delegations.run("orchestrator", args, identity, { emit() {} });
    assert.equal(repeated.status, "recovery_required");
    await f.runtime.delegations.cancelConversation("uncertain");
    assert.equal((await f.store.get(task.taskId)).status, "cancelled");
  } finally {
    await f.runtime.close();
  }
});

test("known tool results are reused when a worker checkpoint is replayed before task completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wingman-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "calls");
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(file)}, 'once')`)}`;
  const f = await createDelegationRuntime({ args, child: child([command]) });
  try {
    await startTurn(f.agent, "delegate", "ledger", options());
    const pending = await getPendingApprovals(f.agent, "ledger");
    const original = f.store.update.bind(f.store);
    let fail = true;
    f.store.update = (id, mutation) =>
      original(id, (current) => {
        const next = mutation(current);
        if (fail && next.status === "completed") {
          fail = false;
          throw new Error("Crash after saved tool result");
        }
        return next;
      });
    await resumeTurn(f.agent, { [pending[0].id]: true }, "ledger", options());
    const [task] = await f.store.listConversation("ledger");
    assert.equal(task.status, "running");
    assert.equal(task.tools[0].status, "completed");
    const { executionMiddleware } = await import("../src/delegation/execution.ts");
    const worker = await Agent.create(f.runtime, "operator", [
      executionMiddleware(f.store, task.taskId, task.ownerToken, 8),
    ]);
    let checkpoint;
    for await (const state of worker.app.graph.getStateHistory({
      configurable: { thread_id: task.checkpointThreadId },
    })) {
      if (state.next.includes("tools")) {
        checkpoint = state;
        break;
      }
    }
    assert.ok(checkpoint);
    await worker.app.graph.updateState(checkpoint.config, {}, "model_request");
    await runTurn(worker, null, task.checkpointThreadId, {
      ...options(),
      delegatedTaskId: task.taskId,
    });
    assert.equal(await readFile(file, "utf8"), "once");
  } finally {
    await f.runtime.close();
  }
});

test("long approval waits do not consume processing budget, but exhausted processing cannot resume", async () => {
  for (const exhausted of [false, true]) {
    const f = await createDelegationRuntime({ args, child: child(["uptime"]) });
    try {
      await startTurn(f.agent, "delegate", "budgets", options());
      const [task] = await f.store.listConversation("budgets");
      await f.store.update(task.taskId, (current) => ({
        ...current,
        pausedAt: new Date(Date.now() - 600000).toISOString(),
        ...(exhausted ? { processingMs: 30000 } : {}),
      }));
      const response = await f.runtime.delegations.resume(
        "orchestrator",
        task.taskId,
        Object.fromEntries(task.pendingApprovals.map((item) => [item.id, false])),
        { emit() {} },
      );
      assert.equal(response.status, exhausted ? "failed" : "completed");
      assert.ok(response.approvalWaitMs >= 600000);
      if (exhausted) {
        assert.match(response.error, /processing-time budget/);
        assert.equal(f.trace.calls.filter((call) => call.child).length, 1);
      } else assert.ok(response.processingMs < 30000);
    } finally {
      await f.runtime.close();
    }
  }
});

test("sequential worker approval rounds replay in order without applying an earlier answer to a later command", async () => {
  const f = await createDelegationRuntime({
    args,
    child: async (messages) => {
      const results = messages.filter(ToolMessage.isInstance);
      if (results.length >= 2) return results.map((message) => message.text).join("\n");
      return [
        {
          id: `stage-${results.length}`,
          name: "exec_bash_command",
          args: { command: results.length ? "date" : "uptime" },
          type: "tool_call",
        },
      ];
    },
  });
  try {
    const first = await startTurn(f.agent, "delegate", "sequential", options());
    assert.equal(first.kind, "paused");
    assert.equal(first.approvals[0].command, "uptime");
    const second = await resumeTurn(
      f.agent,
      { [first.approvals[0].id]: false },
      "sequential",
      options(),
    );
    assert.equal(second.kind, "paused");
    assert.equal(second.approvals[0].command, "date");
    assert.notEqual(first.approvals[0].id, second.approvals[0].id);
    const final = await resumeTurn(
      f.agent,
      { [second.approvals[0].id]: true },
      "sequential",
      options(),
    );
    assert.equal(final.kind, "done");
    const [task] = await f.store.listConversation("sequential");
    assert.equal(task.status, "completed");
    assert.equal(task.approvalRounds.length, 2);
    assert.deepEqual(Object.values(task.approvalRounds[0].answers), [false]);
    assert.deepEqual(Object.values(task.approvalRounds[1].answers), [true]);
    assert.match(task.tools[0].result.data.content, /Declined/);
    assert.match(task.tools[1].result.data.content, /exit_code/);
  } finally {
    await f.runtime.close();
  }
});

test("a tool that performs an action and then fails cannot be silently retried", async () => {
  const { tool } = await import("@langchain/core/tools");
  const { z } = await import("zod");
  let actions = 0;
  const fragile = tool(
    async () => {
      actions++;
      throw new Error("PRIVATE TOOL FAILURE");
    },
    {
      name: "fragile",
      description: "Action with an uncertain completion",
      schema: z.object({}),
    },
  );
  const f = await createDelegationRuntime({
    args,
    operatorTools: [fragile],
    child: async (messages) => {
      return messages.some(ToolMessage.isInstance)
        ? "must not claim success"
        : [{ id: "action", name: "fragile", args: {}, type: "tool_call" }];
    },
  });
  try {
    const result = await startTurn(f.agent, "delegate", "uncertain-action", options());
    assert.match(result.text, /recovery_required/);
    assert.doesNotMatch(result.text, /PRIVATE TOOL FAILURE/);
    const [task] = await f.store.listConversation("uncertain-action");
    assert.equal(task.status, "recovery_required");
    assert.equal(task.tools[0].status, "uncertain");
    await f.runtime.delegations.run(
      "orchestrator",
      task.request,
      {
        planId: task.planId,
        planTaskKey: task.planTaskKey,
        conversationId: task.conversationId,
        parentExecutionId: task.parentExecutionId,
        parentToolCallId: task.parentToolCallId,
      },
      { emit() {} },
    );
    assert.equal(actions, 1);
  } finally {
    await f.runtime.close();
  }
});
