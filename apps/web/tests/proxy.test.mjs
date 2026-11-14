import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { apiGuard, backendConfig } from "../server/backend.ts";

function checkGuard(config, url, headers = {}) {
  let next = false;
  let status;
  let body;
  apiGuard(config)(
    { url, headers },
    {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = value;
      },
    },
    () => {
      next = true;
    },
  );
  return { next, status, body };
}

test("environment configuration stays server-side and rejects invalid destinations", () => {
  assert.deepEqual(backendConfig({ PORT: "3002", WINGMAN_API_TOKEN: " test " }), {
    url: "http://127.0.0.1:3002",
    token: "test",
  });
  for (const url of [
    "file:///tmp/a",
    "https://user:secret@host",
    "http://host?token=x",
    "http://host/#x",
  ])
    assert.throws(() => backendConfig({ WINGMAN_API_URL: url }));
  assert.equal(checkGuard(backendConfig({}), "/api/threads").status, 503);
  assert.equal(checkGuard(backendConfig({}), "/").next, true);
});

test("private proxy rejects foreign origins and unrelated backend paths", () => {
  const config = backendConfig({ WINGMAN_API_TOKEN: "test" });
  assert.equal(
    checkGuard(config, "/api/threads", { host: "127.0.0.1:5173", origin: "http://other.invalid" })
      .status,
    403,
  );
  assert.equal(
    checkGuard(config, "/api/threads", { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" })
      .next,
    true,
  );
  assert.equal(checkGuard(config, "/api/tasks").next, true);
  assert.equal(checkGuard(config, "/api/tasks/runs?jobId=test").next, true);
  assert.equal(checkGuard(config, "/api/tasks/test").next, true);
  assert.equal(checkGuard(config, "/api/sandboxes").next, true);
  assert.equal(checkGuard(config, "/api/sandboxes/chat-1/output").status, 404);
  assert.equal(checkGuard(config, "/api/sandboxes/chat-1/stop").next, true);
  assert.equal(checkGuard(config, "/api/sandboxes/chat-1").next, true);
  assert.equal(checkGuard(config, "/api/sandboxes/chat-1/stop/extra").status, 404);
  assert.equal(checkGuard(config, "/api/sandboxes/chat-1/exec").status, 404);
  assert.equal(checkGuard(config, "/api/sandboxesevil").status, 404);
  assert.equal(checkGuard(config, "/api/tasksevil").status, 404);
  assert.equal(checkGuard(config, "/api/tasks/../admin").status, 404);
  assert.equal(checkGuard(config, "/api/admin").status, 404);
  assert.equal(checkGuard(config, "/api/threadsevil").status, 404);
  assert.equal(checkGuard(config, "/api/threads/../admin").status, 404);
  assert.equal(checkGuard(config, "/api/threads/%2e%2e/admin").status, 404);
});

test(
  "the shipped web proxy injects auth and rejects cross-origin requests",
  { timeout: 20_000 },
  async (t) => {
    const token = "proxy-test-token-must-stay-on-server";
    const requests = [];
    const upstream = createHttpServer((req, res) => {
      requests.push({
        url: req.url,
        auth: req.headers.authorization,
      });
      res.end(JSON.stringify({ threads: [], nextCursor: null }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const previousUrl = process.env.WINGMAN_API_URL;
    const previousToken = process.env.WINGMAN_API_TOKEN;
    process.env.WINGMAN_API_URL = `http://127.0.0.1:${upstream.address().port}`;
    process.env.WINGMAN_API_TOKEN = token;
    let server;
    t.after(async () => {
      if (server) await server.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      if (previousUrl === undefined) delete process.env.WINGMAN_API_URL;
      else process.env.WINGMAN_API_URL = previousUrl;
      if (previousToken === undefined) delete process.env.WINGMAN_API_TOKEN;
      else process.env.WINGMAN_API_TOKEN = previousToken;
    });
    server = await createViteServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${base}/api/threads`, {
      headers: { authorization: "Bearer client-must-not-override" },
    });
    assert.equal(list.status, 200);
    assert.ok(!(await list.text()).includes(token));
    assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
    assert.equal((await fetch(`${base}/api/threads/thread/events`)).status, 404);
    assert.deepEqual(requests, [
      { url: "/threads", auth: `Bearer ${token}` },
      { url: "/tasks", auth: `Bearer ${token}` },
    ]);
    const beforeRejected = requests.length;
    const rejected = await fetch(`${base}/api/threads`, {
      headers: { Origin: "http://other.invalid" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(requests.length, beforeRejected);
  },
);

test(
  "WebSocket proxy accepts only same-origin upgrades and injects backend auth",
  { timeout: 20_000 },
  async (t) => {
    const { default: WebSocket, WebSocketServer } = await import("ws");
    const upstream = createHttpServer();
    const wsServer = new WebSocketServer({ server: upstream });
    const requests = [];
    wsServer.on("connection", (client, request) => {
      requests.push({
        auth: request.headers.authorization,
        url: request.url,
        origin: request.headers.origin,
      });
      client.send("connected");
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const previousUrl = process.env.WINGMAN_API_URL;
    const previousToken = process.env.WINGMAN_API_TOKEN;
    process.env.WINGMAN_API_URL = `http://127.0.0.1:${upstream.address().port}`;
    process.env.WINGMAN_API_TOKEN = "proxy-ws-test";
    let server;
    t.after(async () => {
      if (server) await server.close();
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      if (previousUrl === undefined) delete process.env.WINGMAN_API_URL;
      else process.env.WINGMAN_API_URL = previousUrl;
      if (previousToken === undefined) delete process.env.WINGMAN_API_TOKEN;
      else process.env.WINGMAN_API_TOKEN = previousToken;
    });
    server = await createViteServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const port = server.httpServer.address().port;
    const url = `ws://127.0.0.1:${port}/api/sandboxes/chat-1/output/ws`;
    const accepted = new WebSocket(url, { headers: { origin: `http://127.0.0.1:${port}` } });
    const [data] = await new Promise((resolve, reject) => {
      accepted.once("message", (...args) => resolve(args));
      accepted.once("error", reject);
    });
    assert.equal(data.toString(), "connected");
    assert.deepEqual(requests, [
      {
        auth: "Bearer proxy-ws-test",
        url: "/sandboxes/chat-1/output/ws",
        origin: "http://localhost:5173",
      },
    ]);
    accepted.terminate();
    const chat = new WebSocket(
      `ws://127.0.0.1:${port}/api/threads/chat-1/events/ws?after=chat-1%3A2`,
      { headers: { origin: `http://127.0.0.1:${port}` } },
    );
    await new Promise((resolve, reject) => {
      chat.once("message", resolve);
      chat.once("error", reject);
    });
    assert.deepEqual(requests[1], {
      auth: "Bearer proxy-ws-test",
      url: "/threads/chat-1/events/ws?after=chat-1%3A2",
      origin: "http://localhost:5173",
    });
    chat.terminate();
    const rejected = new WebSocket(url, { headers: { origin: "http://other.invalid" } });
    await new Promise((resolve) => {
      rejected.on("error", () => {});
      rejected.once("close", resolve);
    });
    assert.equal(requests.length, 2);
  },
);
