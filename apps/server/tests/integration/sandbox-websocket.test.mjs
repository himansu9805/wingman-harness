import { quote } from "shell-quote";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import pg from "pg";
import WebSocket from "ws";
import { DockerCommandExecutor } from "../../../../packages/core/src/capabilities/execution/sandbox/docker-command-executor.ts";
import module from "../../dist/sandboxes/sandbox-websocket.js";

const url = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!url) throw new Error("Set TEST_POSTGRES_CONNECTION_STRING to an isolated test database");
const { attachSandboxWebSocket } = module;

test(
  "sandbox PTY output streams over WebSocket and replays after reconnect",
  { timeout: 180_000 },
  async (t) => {
    const schema = `docker_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const executor = new DockerCommandExecutor(
      scopedUrl.toString(),
      new URL("../../../../packages/core/sandbox", import.meta.url).pathname,
    );
    const threadId = `integration-${randomUUID()}`;
    const shutdown = new AbortController();
    const server = createServer();
    let ws;
    t.after(async () => {
      ws?.terminate();
      shutdown.abort();
      await new Promise((resolve) => server.close(resolve));
      await executor.release(threadId);
      await executor.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await executor.init();
    const context = { threadId, target: "sandbox", cwd: "/tmp" };
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    attachSandboxWebSocket(
      server,
      () => executor,
      "integration-token",
      shutdown.signal,
      "http://localhost:5173",
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${server.address().port}/sandboxes/${threadId}/output/ws`;
    const connect = async (suffix = "") => {
      const client = new WebSocket(`${base}${suffix}`, {
        headers: { authorization: "Bearer integration-token" },
      });
      const events = [];
      let wake;
      client.on("message", (data) => {
        events.push(JSON.parse(data.toString()));
        wake?.();
      });
      const waitFor = async (predicate) => {
        while (!events.some(predicate))
          await new Promise((resolve) => {
            wake = resolve;
          });
        return events.find(predicate);
      };
      await once(client, "open");
      await waitFor((event) => event.type === "ready");
      return { client, events, waitFor };
    };
    const first = await connect();
    ws = first.client;
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    await first.waitFor(
      (event) => event.type === "resize.accepted" && event.cols === 100 && event.rows === 40,
    );
    const size = await executor.executeShell("stty size", context);
    assert.equal(size.stdout.trim(), "40 100");
    const result = await executor.executeShell("printf LIVEPTY", context);
    assert.equal(result.exit_code, 0);
    await first.waitFor((event) => event.kind === "command.completed" && event.exitCode === 0);
    assert(first.events.some((event) => event.kind === "output" && event.text.includes("LIVEPTY")));
    const started = first.events.findLast((event) => event.kind === "command.started");
    const completed = first.events.findLast((event) => event.kind === "command.completed");
    const output = first.events.findLast(
      (event) => event.kind === "output" && event.text.includes("LIVEPTY"),
    );
    assert.equal(started.commandId, completed.commandId);
    assert.equal(output.observedDuringCommandId, started.commandId);

    const last = first.events.at(-1);
    ws.terminate();
    await once(ws, "close");
    assert.equal((await executor.executeShell("printf REPLAYPTY", context)).exit_code, 0);
    const second = await connect(
      `?after=${encodeURIComponent(`${last.generation}:${last.sequence}`)}`,
    );
    ws = second.client;
    const ready = second.events.find((event) => event.type === "ready");
    assert.equal(ready.gap, false);
    await second.waitFor((event) => event.kind === "output" && event.text.includes("REPLAYPTY"));
  },
);
