import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:5173",
});
for (const name of ["window", "document", "HTMLElement", "localStorage"])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { renderHook, act, waitFor, cleanup } = await import("@testing-library/react");
const { transcript } = await import("../src/features/chat/model/transcript.ts");
const { turnContent } = await import("../src/features/chat/model/turn-content.ts");
const { useWingman } = await import("../src/features/chat/model/useWingman.ts");
const connection = { url: "http://local.test", token: "test-only" };

function apiFixture({ completeReplay = true } = {}) {
  const controllers = new Map();
  const pending = new Map();
  const history = new Map();
  const snapshots = new Map();
  const sequences = new Map();
  const calls = [];
  let postGate;
  globalThis.WebSocket = class {
    readyState = 0;
    constructor(raw) {
      const url = new URL(raw);
      const id = url.pathname.split("/")[2];
      const cursor = url.searchParams.get("after") ?? `${id}:0`;
      calls.push({ endpoint: "events", eventCursor: cursor });
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        controllers.set(id, this);
        this.onopen?.();
        if (completeReplay) this.emit({ type: "replay_complete", cursor });
      });
    }
    emit(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "" });
    }
  };
  globalThis.fetch = async (raw, options = {}) => {
    const url = new URL(raw);
    const parts = url.pathname.split("/");
    const id = parts[2];
    const endpoint = parts[3];
    calls.push({
      endpoint,
      method: options.method,
      body: options.body,
    });
    if (options.method === "POST" && !id) return Response.json({ id: "created" }, { status: 201 });
    if (options.method === "POST")
      return postGate ? postGate() : Response.json({ runId: "accepted" }, { status: 202 });
    if (endpoint === "pending") return Response.json(pending.get(id) ?? []);
    if (endpoint === "messages") {
      const cursor = url.searchParams.get("cursor");
      const key = cursor ?? id;
      const page = history.get(key) ?? { messages: [], nextCursor: null };
      if (url.searchParams.has("activity")) {
        const snapshot = snapshots.get(key) ?? { cursor: `${id}:0`, events: [] };
        if (!cursor) sequences.set(id, Number(snapshot.cursor.split(":").at(-1)));
        return Response.json({ ...page, activity: snapshot });
      }
      return Response.json(page);
    }
    return Response.json({
      threads: [
        { id: "one", title: "One", hasScheduledTasks: true },
        {
          id: "two",
          title: "Two",
          hasScheduledTasks: false,
          source: "scheduled",
          scheduled: { taskId: "job", taskRunId: "run", originThreadId: "one" },
        },
      ],
      nextCursor: null,
    });
  };
  return {
    pending,
    history,
    snapshots,
    calls,
    setPost: (fn) => {
      postGate = fn;
    },
    completeReplay(id) {
      controllers
        .get(id)
        .emit({ type: "replay_complete", cursor: `${id}:${sequences.get(id) ?? 0}` });
    },
    emit(id, payload) {
      const sequence = (sequences.get(id) ?? 0) + 1;
      sequences.set(id, sequence);
      controllers.get(id).emit({ type: "event", id: `${id}:${sequence}`, event: payload });
    },
  };
}

test("a terminal WebSocket event arriving before POST returns never regresses to running", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  fixture.setPost(async () => {
    fixture.emit("one", { type: "done", runId: "accepted", text: "finished" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ runId: "accepted" }, { status: 202 });
  });
  await act(async () => {
    await hook.result.current.send("hello");
  });
  assert.equal(hook.result.current.activity.phase, "done");
  assert.equal(hook.result.current.working, false);
});

test("an approval arriving before resume acceptance remains visible", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  fixture.setPost(async () => {
    fixture.emit("one", {
      type: "approval",
      runId: "accepted",
      approvals: [{ id: "second", command: "test-2" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ runId: "accepted" }, { status: 202 });
  });
  await act(async () => {
    await hook.result.current.resume({ first: true });
  });
  assert.equal(hook.result.current.pending[0].id, "second");
  assert.equal(hook.result.current.activity.phase, "paused");
});

test("switching threads clears old state and historical terminal events clear stale approval cards", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => {
    fixture.emit("one", {
      type: "approval",
      runId: "run",
      approvals: [{ id: "old", command: "test" }],
    });
  });
  assert.equal(hook.result.current.pending.length, 1);
  await act(async () => {
    hook.result.current.select("two");
  });
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  assert.equal(hook.result.current.pending.length, 0);
  await act(async () => {
    fixture.emit("two", {
      type: "approval",
      runId: "old",
      approvals: [{ id: "past", command: "old" }],
    });
    fixture.emit("two", { type: "done", runId: "new", text: "complete" });
  });
  assert.equal(hook.result.current.pending.length, 0);
  assert.equal(hook.result.current.activity.phase, "done");
});

test("submitted prompts appear before acceptance and survive stale history without duplicating repeated text", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const previous = { id: "previous", role: "user", text: "hello" };
  fixture.history.set("one", { messages: [previous], nextCursor: null });
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  let accept;
  fixture.setPost(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  let sending;
  await act(async () => {
    sending = hook.result.current.send("hello");
  });
  assert.deepEqual(
    hook.result.current.history.messages.map((message) => message.text),
    ["hello", "hello"],
  );
  assert.match(hook.result.current.history.messages[1].id, /^local:/);
  await act(async () => {
    accept(Response.json({ runId: "accepted" }, { status: 202 }));
    await sending;
  });
  await waitFor(() => assert.equal(hook.result.current.working, false));
  assert.equal(
    hook.result.current.history.messages.length,
    2,
    "stale history must retain the local prompt",
  );
  fixture.history.set("one", {
    messages: [previous, { id: "saved", role: "user", text: "hello" }],
    nextCursor: null,
  });
  await act(async () => {
    fixture.emit("one", { type: "done", runId: "accepted", text: "reply" });
  });
  await waitFor(() =>
    assert.deepEqual(
      hook.result.current.history.messages.map((message) => message.id),
      ["previous", "saved"],
    ),
  );
});

test("a rejected submission removes the local prompt and reports failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  fixture.setPost(async () => Response.json({ message: "Busy" }, { status: 409 }));
  let result;
  await act(async () => {
    result = await hook.result.current.send("hello");
  });
  assert.equal(result, false);
  assert.equal(hook.result.current.history.messages.length, 0);
  assert.match(hook.result.current.error, /Busy/);
});

test("switching threads while a submission is pending discards its local prompt", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  let accept;
  fixture.setPost(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  let sending;
  await act(async () => {
    sending = hook.result.current.send("hello");
  });
  await act(async () => {
    hook.result.current.select("two");
  });
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => {
    accept(Response.json({ runId: "accepted" }, { status: 202 }));
    await sending;
  });
  assert.equal(hook.result.current.threadId, "two");
  assert.equal(hook.result.current.history.messages.length, 0);
});

test("new conversation stays local until the first message is submitted", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => {
    hook.result.current.create();
  });
  assert.equal(hook.result.current.threadId, null);
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 0);
  let accept;
  fixture.setPost(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  let sending;
  await act(async () => {
    sending = hook.result.current.send("first message");
  });
  assert.equal(hook.result.current.history.messages[0].text, "first message");
  await act(async () => {
    accept(Response.json({ runId: "accepted" }, { status: 202 }));
    await sending;
  });
  await waitFor(() => assert.equal(hook.result.current.threadId, "created"));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  assert.equal(hook.result.current.history.messages[0].text, "first message");
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 2);
  assert.equal(hook.result.current.activity.phase, "running");
});

test("opening the already selected conversation preserves its live event subscription", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => {
    hook.result.current.select("one");
  });
  await act(async () => {
    fixture.emit("one", { type: "done", runId: "still-live", text: "done" });
  });
  assert.equal(hook.result.current.activity.phase, "done");
  assert.equal(hook.result.current.stream, "live");
});

test("a deleted result conversation reports why it cannot be opened", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "missing");
  apiFixture();
  const fetcher = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    String(url).includes("/missing/messages")
      ? Promise.resolve(
          Response.json({ message: "Conversation no longer exists" }, { status: 404 }),
        )
      : fetcher(url, options);
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.threadId, null));
  assert.match(hook.result.current.error, /no longer exists/);
});

test("catalogue refresh preserves scheduled result provenance", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.removeItem("wingman.thread");
  apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.threads.length, 2));
  assert.deepEqual(hook.result.current.threads.find((thread) => thread.id === "two").scheduled, {
    taskId: "job",
    taskRunId: "run",
    originThreadId: "one",
  });
  await act(async () => {
    await hook.result.current.refreshThreads();
  });
  assert.equal(
    hook.result.current.threads.find((thread) => thread.id === "two").source,
    "scheduled",
  );
});

test("scheduled indicator comes directly from the catalogue without task requests", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.removeItem("wingman.thread");
  apiFixture();
  const requests = [];
  const fetchCatalogue = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    requests.push(new URL(url).pathname);
    return fetchCatalogue(url, options);
  };
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.threads.length, 2));
  assert.equal(
    hook.result.current.threads.find((thread) => thread.id === "one").hasScheduledTasks,
    true,
  );
  assert.equal(
    hook.result.current.threads.find((thread) => thread.id === "two").hasScheduledTasks,
    false,
  );
  await act(async () => hook.result.current.refreshThreads());
  assert.equal(
    requests.some((path) => path.startsWith("/tasks")),
    false,
  );
});

test("generated title updates the catalogue after completion and survives stale catalogue responses", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await waitFor(() => assert.equal(hook.result.current.threads.length, 2));
  await act(async () => {
    fixture.emit("one", { type: "done", runId: "run", text: "Finished" });
    fixture.emit("one", { type: "thread_title", runId: "run", title: "Inspect Docker containers" });
  });
  assert.equal(hook.result.current.activity.phase, "done");
  assert.equal(
    hook.result.current.threads.find((thread) => thread.id === "one").title,
    "Inspect Docker containers",
  );
  await act(async () => {
    await hook.result.current.refreshThreads();
  });
  assert.equal(
    hook.result.current.threads.find((thread) => thread.id === "one").title,
    "Inspect Docker containers",
  );
  assert.equal(hook.result.current.activity.phase, "done");
});

test("title notifications preserve pending approval and never become chat activity", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => {
    fixture.emit("one", {
      type: "approval",
      runId: "run",
      approvals: [{ id: "approval", command: "uptime" }],
    });
    fixture.emit("one", { type: "thread_title", runId: "run", title: "Check system uptime" });
  });
  assert.equal(hook.result.current.activity.phase, "paused");
  assert.equal(hook.result.current.pending.length, 1);
  assert(!hook.result.current.activity.events.some((event) => event.type === "thread_title"));
});

test("saved delegation renders from the snapshot before subscribing at its watermark", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture({ completeReplay: false });
  fixture.history.set("one", {
    messages: [
      { id: "prompt", role: "user", text: "Run the task" },
      {
        id: "call",
        role: "assistant",
        text: "",
        toolCalls: [{ id: "delegate", name: "delegate_task", args: {} }],
      },
      { id: "answer", role: "assistant", text: "Already finished" },
    ],
    nextCursor: null,
  });
  fixture.snapshots.set("one", {
    cursor: "one:900",
    events: [
      {
        type: "delegation_plan",
        runId: "old",
        sequence: "898",
        planId: "plan",
        parentToolCallId: "delegate",
        parentExecutionId: "prompt",
        status: "completed",
        tasks: [],
      },
      { type: "done", runId: "old", sequence: "900", text: "Already finished" },
    ],
  });
  const renders = [];
  const hook = renderHook(() => {
    const model = useWingman(connection);
    const turn = transcript(model.history.messages, model.activity.events)[0];
    if (turn?.messages.length) renders.push(turnContent(turn).map((item) => item.type));
    return model;
  });
  await waitFor(() => {
    assert(fixture.calls.some((call) => call.endpoint === "events"));
    assert.equal(hook.result.current.activity.phase, "done");
  });
  assert.equal(fixture.calls.find((call) => call.endpoint === "events").eventCursor, "one:900");
  assert.deepEqual(renders[0], ["delegation", "text"]);
  assert.equal(hook.result.current.activity.phase, "done");

  // A run arriving between the snapshot and subscription is caught up before going live.
  await act(async () => {
    fixture.emit("one", { type: "route", runId: "new", choice: "fast" });
  });
  assert.equal(hook.result.current.activity.phase, "done");
  await act(async () => fixture.completeReplay("one"));
  assert.equal(hook.result.current.stream, "live");
  assert.equal(hook.result.current.activity.phase, "running");
  assert(renders.every((content) => !content.includes("tools")));
});

test("loading older activity preserves the current run and its older delegation card survives refresh", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  localStorage.setItem("wingman.thread", "one");
  const fixture = apiFixture();
  fixture.history.set("one", {
    messages: [{ id: "new-prompt", role: "user", text: "Current task" }],
    nextCursor: "older-page",
  });
  fixture.snapshots.set("one", {
    cursor: "one:100",
    events: [{ type: "route", runId: "current", sequence: "100" }],
  });
  fixture.history.set("older-page", {
    messages: [
      { id: "old-prompt", role: "user", text: "Past task" },
      {
        id: "call",
        role: "assistant",
        text: "",
        toolCalls: [{ id: "old-call", name: "delegate_task", args: {} }],
      },
    ],
    nextCursor: null,
  });
  fixture.snapshots.set("older-page", {
    cursor: "one:100",
    events: [
      {
        type: "delegation_plan",
        runId: "past",
        sequence: "10",
        planId: "past-plan",
        parentExecutionId: "old-prompt",
        parentToolCallId: "old-call",
        tasks: [],
        status: "completed",
      },
    ],
  });
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, "live"));
  await act(async () => hook.result.current.older());
  assert.equal(hook.result.current.activity.phase, "running");
  assert.equal(hook.result.current.activity.runId, "current");
  assert.equal(hook.result.current.history.nextCursor, null);
  await act(async () => {
    fixture.emit("one", { type: "done", runId: "current", text: "Finished" });
  });
  await waitFor(() =>
    assert(fixture.calls.filter((call) => call.endpoint === "messages").length >= 4),
  );
  const { history, activity } = hook.result.current;
  const [older] = transcript(history.messages, activity.events);
  assert.deepEqual(
    turnContent(older).map(({ type }) => type),
    ["delegation"],
  );
  assert.equal(history.nextCursor, null);
});
