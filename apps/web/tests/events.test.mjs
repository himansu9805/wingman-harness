import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEvents } from "../src/features/chat/api/events.ts";
import { applyEvent, emptyActivity, toolsWithResults } from "../src/features/chat/model/events.ts";

function socketFactory(scenarios, requests) {
  return (url) => {
    const socket = {
      readyState: 0,
      close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: "" });
      },
    };
    requests.push(url);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.onopen?.();
      scenarios[requests.length - 1](socket);
    });
    return socket;
  };
}
const event = (sequence, type) =>
  JSON.stringify({
    type: "event",
    id: `thread:${sequence}`,
    event: { type, runId: "run", text: "answer" },
  });
const replay = (sequence) =>
  JSON.stringify({ type: "replay_complete", cursor: `thread:${sequence}` });

test("WebSocket reconnection resumes the cursor and preserves replay boundaries", async () => {
  const controller = new AbortController();
  const received = [];
  const completed = [];
  const requests = [];
  const send = (socket, data) => socket.onmessage?.({ data });
  await watchEvents({
    connection: { url: "http://local.test" },
    threadId: "thread",
    signal: controller.signal,
    wait: async () => {},
    onStatus() {},
    onError(error) {
      throw error;
    },
    onReplayComplete() {
      completed.push(received.length);
    },
    onEvent(value, id, replaying) {
      received.push({ id, replaying });
      if (id === "thread:3") controller.abort();
    },
    socketFactory: socketFactory(
      [
        (socket) => {
          send(socket, event(1, "route"));
          socket.close();
        },
        (socket) => {
          send(socket, event(1, "route"));
          send(socket, event(2, "done"));
          send(socket, replay(2));
          send(socket, event(3, "route"));
        },
      ],
      requests,
    ),
  });
  assert.deepEqual(received, [
    { id: "thread:1", replaying: true },
    { id: "thread:2", replaying: true },
    { id: "thread:3", replaying: false },
  ]);
  assert.deepEqual(completed, [2]);
  assert.equal(new URL(requests[1]).searchParams.get("after"), "thread:1");
  assert.equal(new URL(requests[0]).protocol, "ws:");
});

test("rejected WebSocket connections stop retrying", async () => {
  for (const status of [400, 401, 403, 404]) {
    const requests = [];
    let error;
    await watchEvents({
      connection: { url: "http://local.test" },
      threadId: "thread",
      signal: new AbortController().signal,
      onStatus() {},
      onEvent() {
        assert.fail();
      },
      onError(value) {
        error = value;
      },
      wait: async () => assert.fail(),
      socketFactory: socketFactory(
        [
          (socket) => {
            socket.readyState = 3;
            socket.onclose?.({ code: status + 4000, reason: "Rejected" });
          },
        ],
        requests,
      ),
    });
    assert.equal(requests.length, 1);
    assert.equal(error.status, status);
  }
});

test("an already-aborted listener opens no WebSocket", async () => {
  await watchEvents({
    connection: { url: "http://local.test" },
    threadId: "thread",
    signal: AbortSignal.abort(),
    onStatus() {},
    onEvent() {
      assert.fail();
    },
    onError() {
      assert.fail();
    },
    socketFactory() {
      assert.fail();
    },
  });
});

test("approval pauses a run and tool identifiers preserve results across resume runs", () => {
  let state = applyEvent(emptyActivity, {
    type: "tool_call",
    runId: "first",
    name: "bash",
    toolCallId: "call",
    args: { command: "uptime" },
  });
  state = applyEvent(state, {
    type: "approval",
    runId: "first",
    approvals: [{ id: "approval", command: "uptime" }],
  });
  assert.equal(state.phase, "paused");
  state = applyEvent(state, {
    type: "tool_result",
    runId: "resume",
    name: "bash",
    toolCallId: "call",
    output: "up 1 day",
    truncated: false,
  });
  assert.equal(state.phase, "running");
  assert.deepEqual(
    toolsWithResults([{ id: "call", name: "bash", args: {} }], state.events)[0].result,
    { output: "up 1 day", truncated: false },
  );
  state = applyEvent(state, { type: "done", runId: "resume", text: "up 1 day" });
  assert.equal(state.phase, "done");
  assert.equal(state.runId, "resume");
});

test("reused tool IDs never overwrite completed history or borrow an earlier result", () => {
  const completed = {
    id: "reused",
    name: "bash",
    args: {},
    result: { output: "old output", truncated: false },
  };
  const events = [
    {
      type: "tool_result",
      runId: "old",
      name: "bash",
      toolCallId: "reused",
      output: "old output",
      truncated: false,
    },
    { type: "tool_call", runId: "new", name: "bash", toolCallId: "reused", args: {} },
  ];
  assert.equal(
    toolsWithResults([{ id: "reused", name: "bash", args: {} }], events)[0].result,
    undefined,
  );
  events.push({
    type: "tool_result",
    runId: "new",
    name: "bash",
    toolCallId: "reused",
    output: "new output",
    truncated: false,
  });
  assert.deepEqual(toolsWithResults([completed], events)[0].result, completed.result);
});
