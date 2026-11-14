import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import module from "../dist/threads/thread-events-websocket.js";

const { attachThreadEventsWebSocket } = module;

test(
  "chat WebSocket authenticates and preserves replay and live event ordering",
  { timeout: 10_000 },
  async (t) => {
    const shutdown = new AbortController();
    const rows = [1, 2].map((sequence) => ({
      threadId: "chat-1",
      sequence: String(sequence),
      runId: "run",
      createdAt: "2026-01-01T00:00:00Z",
      payload: { type: "done", text: String(sequence) },
    }));
    const agent = {
      shutdownSignal: shutdown.signal,
      async requireThread(id) {
        if (id !== "chat-1") throw new Error("missing");
      },
      events: {
        async latest() {
          return "2";
        },
        async listAfter(_id, cursor) {
          return rows.filter((row) => BigInt(row.sequence) > BigInt(cursor));
        },
      },
    };
    const server = createServer();
    attachThreadEventsWebSocket(server, agent, "secret", "http://localhost:5173");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      shutdown.abort();
      server.close();
    });
    const base = `ws://127.0.0.1:${server.address().port}/threads/chat-1/events/ws`;
    const denied = new WebSocket(base);
    const [code] = await once(denied, "close");
    assert.equal(code, 4401);
    const client = new WebSocket(`${base}?after=chat-1%3A1`, {
      headers: { authorization: "Bearer secret" },
    });
    const messages = [];
    client.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(client, "open");
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages[0].id, "chat-1:2");
    assert.equal(messages[1].type, "replay_complete");
    rows.push({
      threadId: "chat-1",
      sequence: "3",
      runId: "run",
      createdAt: "2026-01-01T00:00:00Z",
      payload: { type: "done", text: "3" },
    });
    while (messages.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(messages[2].id, "chat-1:3");
    client.send("not permitted");
    const [closed] = await once(client, "close");
    assert.equal(closed, 1008);
  },
);
