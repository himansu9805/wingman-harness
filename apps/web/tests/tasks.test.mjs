import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createTasksApi } from "../src/features/schedules/api/tasks.ts";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:5173",
});
for (const name of ["window", "document", "HTMLElement", "localStorage"])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { renderHook, act, waitFor, cleanup } = await import("@testing-library/react");
const { useScheduledTasks } = await import("../src/features/schedules/model/useScheduledTasks.ts");
const connection = { url: "http://local.test" };
const task = {
  id: "one",
  prompt: "Check workspace",
  threadId: "thread",
  state: "repeating",
  nextRunAt: null,
  repeatInterval: "1 hour",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(t) {
  const original = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = original;
  });
  const calls = [];
  let cancel;
  globalThis.fetch = async (raw, options = {}) => {
    const url = new URL(raw);
    calls.push({ url, ...options });
    if (options.method === "DELETE") return cancel ? cancel() : new Response(null, { status: 204 });
    return Response.json({
      schedulerEnabled: false,
      tasks: url.searchParams.has("cursor") ? [task, { ...task, id: "two" }] : [task],
      nextCursor: url.searchParams.has("cursor") ? null : "next-page",
    });
  };
  return {
    calls,
    setCancel: (fn) => {
      cancel = fn;
    },
  };
}

test("task client forwards cursors and task identifiers without browser credentials or mutation retries", async () => {
  const calls = [];
  const api = createTasksApi(connection, async (url, options) => {
    calls.push({ url: new URL(url), options });
    return options.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ tasks: [], runs: [], nextCursor: null });
  });
  const signal = new AbortController().signal;
  await api.list(signal, "next+page");
  await api.cancel("job/id", signal);
  assert.equal(calls[0].url.searchParams.get("cursor"), "next+page");
  assert.equal(calls[1].url.pathname, "/tasks/job%2Fid");
  assert.equal(calls[1].options.method, "DELETE");
  assert.ok(
    calls.every((call) => call.options.credentials === "same-origin" && !call.options.headers),
  );
});

test("task pages expose disabled scheduling and load more without duplicate rows", async (t) => {
  const fixtureState = fixture(t);
  const hook = renderHook(() => useScheduledTasks(connection));
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  assert.equal(hook.result.current.schedulerEnabled, false);
  assert.ok(fixtureState.calls.every((call) => call.url.pathname === "/tasks"));
  assert.equal(hook.result.current.tasks.items[0].threadId, "thread");
  await act(async () => {
    await hook.result.current.tasks.more();
  });
  assert.deepEqual(
    hook.result.current.tasks.items.map((task) => task.id),
    ["one", "two"],
  );
  assert.ok(fixtureState.calls.some((call) => call.url.searchParams.get("cursor") === "next-page"));
});

test("cancellation prevents duplicate requests and a stale task list cannot resurrect a cancelled row", async (t) => {
  const state = fixture(t);
  const hook = renderHook(() => useScheduledTasks(connection));
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  const gate = deferred();
  state.setCancel(() => gate.promise);
  let first;
  let duplicate;
  await act(async () => {
    first = hook.result.current.cancel(task);
    duplicate = await hook.result.current.cancel(task);
  });
  assert.equal(duplicate, false);
  assert.equal(hook.result.current.cancelling, "one");
  await act(async () => {
    gate.resolve(new Response(null, { status: 204 }));
    await first;
  });
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  assert.deepEqual(hook.result.current.tasks.items, []);
  assert.equal(state.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.match(hook.result.current.notice, /Results remain in the chat/);
});

test("busy cancellation leaves the task visible and surfaces the backend conflict", async (t) => {
  const state = fixture(t);
  const hook = renderHook(() => useScheduledTasks(connection));
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  state.setCancel(async () =>
    Response.json({ message: "Task is locked or running" }, { status: 409 }),
  );
  let result;
  await act(async () => {
    result = await hook.result.current.cancel(task);
  });
  assert.equal(result, false);
  assert.equal(hook.result.current.tasks.items.length, 1);
  assert.match(hook.result.current.actionError, /locked or running/);
});

test("failed listing reports an error rather than masquerading as an empty schedule", async (t) => {
  fixture(t);
  const fetcher = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    new URL(url).pathname.endsWith("/tasks")
      ? Promise.resolve(Response.json({ message: "Task database unavailable" }, { status: 503 }))
      : fetcher(url, options);
  const hook = renderHook(() => useScheduledTasks(connection));
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  assert.match(hook.result.current.tasks.error, /database unavailable/);
  assert.equal(hook.result.current.schedulerEnabled, null);
});

test("a cancellation response after leaving the view cannot write stale UI state", async (t) => {
  const state = fixture(t);
  const hook = renderHook(() => useScheduledTasks(connection));
  await waitFor(() => assert.equal(hook.result.current.tasks.loading, false));
  const gate = deferred();
  state.setCancel(() => gate.promise);
  let cancelling;
  await act(async () => {
    cancelling = hook.result.current.cancel(task);
  });
  hook.unmount();
  let result;
  await act(async () => {
    gate.resolve(new Response(null, { status: 204 }));
    result = await cancelling;
  });
  assert.equal(result, false);
  assert.equal(state.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("schedule descriptions support cron and existing natural-language intervals", async () => {
  const { scheduleDescription } =
    await import("../src/features/schedules/model/schedule-format.ts");
  assert.match(scheduleDescription("0 9 * * *"), /every day/i);
  assert.equal(scheduleDescription("1 hour"), "1 hour");
  assert.equal(scheduleDescription(null), "One-time task");
  assert.equal(scheduleDescription("unrecognised stored schedule"), "unrecognised stored schedule");
});
