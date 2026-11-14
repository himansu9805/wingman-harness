import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import module from "../dist/sandboxes/sandbox-websocket.js";

const { attachSandboxWebSocket } = module;

test("sandbox WebSocket authenticates and streams read-only ordered events", async (t) => {
  let listener;
  let unsubscribed = false;
  const resized = [];
  const generation = "12345678-1234-4123-8123-123456789012";
  const monitor = {
    async resize(id, cols, rows) {
      resized.push({ id, cols, rows });
      return true;
    },
    async subscribeEvents(id, cursor, next) {
      assert.equal(id, "chat-1");
      assert.equal(cursor, null);
      listener = next;
      return {
        cursor: { generation, sequence: 1 },
        events: [{ generation, sequence: 1, text: "old" }],
        gap: false,
        unsubscribe() {
          unsubscribed = true;
        },
      };
    },
  };
  const server = createServer((_req, res) => res.end());
  const shutdown = new AbortController();
  attachSandboxWebSocket(server, () => monitor, "secret", shutdown.signal, "http://localhost:5173");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    shutdown.abort();
    server.close();
  });
  const url = `ws://127.0.0.1:${server.address().port}/sandboxes/chat-1/output/ws`;
  const denied = new WebSocket(url);
  const [, response] = await once(denied, "unexpected-response");
  assert.equal(response.statusCode, 401);
  response.resume();
  const foreign = new WebSocket(url, {
    headers: { authorization: "Bearer secret", origin: "http://other.invalid" },
  });
  const [, foreignResponse] = await once(foreign, "unexpected-response");
  assert.equal(foreignResponse.statusCode, 403);
  foreignResponse.resume();
  const client = new WebSocket(url, { headers: { authorization: "Bearer secret" } });
  const messages = [];
  client.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(client, "open");
  while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(messages[0].type, "ready");
  assert.equal(messages[1].text, "old");
  listener({ generation, sequence: 2, text: "new" });
  while (messages.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(messages[2].sequence, 2);
  client.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
  while (!resized.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(resized, [{ id: "chat-1", cols: 100, rows: 40 }]);
  client.send("not permitted");
  const [code] = await once(client, "close");
  assert.equal(code, 1008);
  for (let attempt = 0; attempt < 50 && !unsubscribed; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(unsubscribed, true);
});
