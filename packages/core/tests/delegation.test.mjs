import assert from "node:assert/strict";
import { test } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { createDelegationRuntime } from "../../../tests/fixtures/delegation-runtime.mjs";
import { startTurn, runTurn } from "../src/core/turn.ts";
import { deleteThreadState, getThreadMessages } from "../src/core/history.ts";
import { createHash } from "node:crypto";
import { DelegationRunner } from "../src/core/delegation/runner.ts";

const options = () => ({ signal: AbortSignal.timeout(10_000) });
const identity = {
  conversationId: "conversation",
  parentExecutionId: "user-message",
  parentToolCallId: "tool-call",
};
const request = { agentId: "analyst", objective: "Analyze", context: "Scoped data" };

test("coordinator delegates one scoped task, persists result and replies in original conversation", async () => {
  const f = await createDelegationRuntime();
  const events = [];
  const usage = [];
  try {
    const result = await startTurn(f.agent, "Analyze this; PRIVATE CHAT CONTEXT", "conversation", {
      ...options(),
      onEvent: async (event) => events.push(event),
      onModelUsage: async (counts) => usage.push(counts),
    });
    assert.equal(result.kind, "done");
    assert.match(result.text, /Coordinator:.*Specialist analysis/);
    const tasks = await f.store.listConversation("conversation");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "completed");
    assert.equal(tasks[0].usage.length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === "delegation").map((event) => event.phase),
      ["started", "completed"],
    );
    assert.equal(usage.length, 3);
    assert.equal(
      usage.reduce((sum, counts) => sum + counts.totalTokens, 0),
      21,
    );
    const worker = f.trace.calls.filter((call) => call.child);
    assert.equal(worker.length, 1);
    assert.deepEqual(worker[0].tools, []);
    assert.doesNotMatch(worker[0].prompt, /ROOT PRIVATE MEMORY/);
    assert.equal(worker[0].messages.filter(HumanMessage.isInstance).length, 1);
    assert.doesNotMatch(
      worker[0].messages.map((message) => message.text).join("\n"),
      /PRIVATE CHAT CONTEXT/,
    );
    assert.match(worker[0].messages.find(HumanMessage.isInstance).text, /Only this scoped context/);
    const parentState = await getThreadMessages(f.agent, "conversation");
    assert.equal(parentState.messages.filter((message) => message.role === "user").length, 1);
  } finally {
    await f.runtime.close();
  }
});

test("simple requests do not create delegated tasks", async () => {
  const f = await createDelegationRuntime();
  try {
    assert.equal(
      (await startTurn(f.agent, "simple hello", "simple-chat", options())).text,
      "Direct response",
    );
    assert.deepEqual(await f.store.listConversation("simple-chat"), []);
    assert.equal(f.trace.calls.filter((call) => call.child).length, 0);
  } finally {
    await f.runtime.close();
  }
});

test("parent tool replay reuses completed result and does not count child usage twice", async () => {
  const f = await createDelegationRuntime();
  try {
    await startTurn(f.agent, "delegate", "replay-chat", options());
    let pending;
    for await (const state of f.agent.app.graph.getStateHistory({
      configurable: { thread_id: "replay-chat" },
    })) {
      if (state.next.includes("tools")) {
        pending = state;
        break;
      }
    }
    assert.ok(pending);
    await f.agent.app.graph.updateState(pending.config, {}, "model_request");
    const events = [];
    const usage = [];
    await runTurn(f.agent, null, "replay-chat", {
      ...options(),
      onEvent: async (event) => events.push(event),
      onModelUsage: async (counts) => usage.push(counts),
    });
    assert.equal(f.trace.calls.filter((call) => call.child).length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === "delegation").map((event) => event.phase),
      ["reused"],
    );
    assert.equal(usage.length, 1);
  } finally {
    await f.runtime.close();
  }
});

test("provider failure is persisted and contributes one missing child usage report", async () => {
  const f = await createDelegationRuntime({
    child: async () => {
      throw new Error("PRIVATE PROVIDER DETAIL");
    },
  });
  const usage = [];
  try {
    const result = await startTurn(f.agent, "delegate", "failed-chat", {
      ...options(),
      onModelUsage: async (counts) => usage.push(counts),
    });
    assert.match(result.text, /Specialist execution failed/);
    assert.doesNotMatch(result.text, /PRIVATE PROVIDER DETAIL/);
    const [task] = await f.store.listConversation("failed-chat");
    assert.equal(task.status, "failed");
    assert.equal(task.usage.length, 1);
    assert.equal(usage.length, 3);
    assert.equal(usage.filter((counts) => counts.totalTokens === null).length, 1);
  } finally {
    await f.runtime.close();
  }
});

test("output is bounded and distinct user turns may reuse provider tool-call IDs", async () => {
  const f = await createDelegationRuntime({ child: async () => "x".repeat(17000) });
  try {
    await startTurn(f.agent, "first", "bounded-chat", options());
    await startTurn(f.agent, "second", "bounded-chat", options());
    const tasks = await f.store.listConversation("bounded-chat");
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0].parentExecutionId, tasks[1].parentExecutionId);
    assert.ok(tasks.every((task) => task.output.length === 16000 && task.truncated));
  } finally {
    await f.runtime.close();
  }
});

test("completed child checkpoints and mappings are removed when the parent chat is deleted", async () => {
  const f = await createDelegationRuntime();
  try {
    await startTurn(f.agent, "delegate", "deleted-chat", options());
    const [task] = await f.store.listConversation("deleted-chat");
    assert.ok(await f.saver.getTuple({ configurable: { thread_id: task.checkpointThreadId } }));
    await deleteThreadState(f.agent, "deleted-chat");
    await deleteThreadState(f.agent, "deleted-chat");
    assert.deepEqual(await f.store.listConversation("deleted-chat"), []);
    assert.equal(
      await f.saver.getTuple({ configurable: { thread_id: task.checkpointThreadId } }),
      undefined,
    );
    assert.equal(
      await f.saver.getTuple({ configurable: { thread_id: "deleted-chat" } }),
      undefined,
    );
  } finally {
    await f.runtime.close();
  }
});

test("persisted uncertain work is not restarted by another runner", async () => {
  const f = await createDelegationRuntime();
  try {
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const { task } = await f.store.claim({
      ...identity,
      parentAgentId: "default",
      request,
      requestHash: hash,
    });
    await f.store.update(task.taskId, (current) => ({
      ...current,
      attempt: 1,
      ownerToken: "00000000-0000-4000-8000-000000000001",
      leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    }));
    const frames = [];
    const replacement = new DelegationRunner(
      f.runtime.agents,
      f.store,
      async () => {
        throw new Error("Must not run an uncertain task");
      },
      async () => {},
    );
    await assert.rejects(
      replacement.run("default", request, identity, { emit: (frame) => frames.push(frame) }),
      /owned by another/,
    );
    assert.equal(frames[0].phase, "blocked");
    await replacement.close();
    assert.equal(f.trace.calls.length, 0);
  } finally {
    await f.runtime.close();
  }
});

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

test("task deadline interrupts the child and persists a bounded failure result", async () => {
  const f = await createDelegationRuntime({
    timeoutMs: 20,
    child: async (_messages, options) => {
      await waitForAbort(options.signal);
      return "must not finish";
    },
  });
  try {
    const result = await startTurn(f.agent, "delegate", "deadline-chat", options());
    assert.match(result.text, /interrupted or timed out/);
    const [task] = await f.store.listConversation("deadline-chat");
    assert.equal(task.status, "interrupted");
    assert.ok(task.finishedAt);
  } finally {
    await f.runtime.close();
  }
});

test("parent cancellation reaches the child and cleanup can drain the task", async () => {
  let started;
  const childStarted = new Promise((resolve) => {
    started = resolve;
  });
  const f = await createDelegationRuntime({
    child: async (_messages, options) => {
      started();
      await waitForAbort(options.signal);
      return "must not finish";
    },
  });
  const controller = new AbortController();
  try {
    const running = startTurn(f.agent, "delegate", "cancelled-chat", { signal: controller.signal });
    const rejected = assert.rejects(running);
    await childStarted;
    controller.abort(new Error("cancel parent"));
    await rejected;
    await f.runtime.delegations.close();
    const [task] = await f.store.listConversation("cancelled-chat");
    assert.equal(task.status, "interrupted");
  } finally {
    await f.runtime.close();
  }
});

test("concurrent duplicate invocations coalesce; a different call in the turn is rejected", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await createDelegationRuntime({
    child: async () => {
      await gate;
      return "shared result";
    },
  });
  try {
    const first = f.runtime.delegations.run("default", request, identity, { emit() {} });
    const duplicate = f.runtime.delegations.run("default", request, identity, { emit() {} });
    await assert.rejects(
      f.runtime.delegations.run(
        "default",
        request,
        { ...identity, parentToolCallId: "other-call" },
        { emit() {} },
      ),
      /Only one/,
    );
    await assert.rejects(
      f.runtime.delegations.run("default", { ...request, context: "different" }, identity, {
        emit() {},
      }),
      /different task data/,
    );
    release();
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(a.taskId, b.taskId);
    assert.equal(f.trace.calls.filter((call) => call.child).length, 1);
    await assert.rejects(
      f.runtime.delegations.run("analyst", request, identity, { emit() {} }),
      /cannot delegate/,
    );
  } finally {
    release();
    await f.runtime.close();
  }
});

test("checkpoint deletion failure keeps the mapping so cleanup can be retried", async () => {
  const f = await createDelegationRuntime();
  try {
    await startTurn(f.agent, "delegate", "retry-delete-chat", options());
    const original = f.saver.deleteThread.bind(f.saver);
    let fail = true;
    f.saver.deleteThread = async (id) => {
      if (fail && id.startsWith("wingman-delegation:")) {
        fail = false;
        throw new Error("temporary delete failure");
      }
      return original(id);
    };
    await assert.rejects(
      deleteThreadState(f.agent, "retry-delete-chat"),
      /temporary delete failure/,
    );
    assert.equal((await f.store.listConversation("retry-delete-chat")).length, 1);
    await deleteThreadState(f.agent, "retry-delete-chat");
    assert.deepEqual(await f.store.listConversation("retry-delete-chat"), []);
  } finally {
    await f.runtime.close();
  }
});

test("unsupported worker tool requests fail without executing any tool", async () => {
  const f = await createDelegationRuntime({
    child: async () => [
      {
        id: "forbidden",
        name: "exec_bash_command",
        args: { command: "pwd" },
        type: "tool_call",
      },
    ],
  });
  try {
    const result = await startTurn(f.agent, "delegate", "forbidden-worker", options());
    assert.match(result.text, /unavailable tool/);
    assert.equal((await f.store.listConversation("forbidden-worker"))[0].status, "failed");
    assert.deepEqual(f.trace.calls.find((call) => call.child).tools, []);
  } finally {
    await f.runtime.close();
  }
});

test("oversized context is rejected before claiming or executing a task", async () => {
  const f = await createDelegationRuntime();
  try {
    await assert.rejects(
      f.runtime.delegations.run("default", { ...request, context: "x".repeat(20001) }, identity, {
        emit() {},
      }),
    );
    assert.deepEqual(await f.store.listConversation(identity.conversationId), []);
    assert.equal(f.trace.calls.length, 0);
  } finally {
    await f.runtime.close();
  }
});
