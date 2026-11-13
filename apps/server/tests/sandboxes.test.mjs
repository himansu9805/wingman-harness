import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import controllerModule from "../dist/sandboxes/sandboxes.controller.js";
import agentModule from "../dist/agent/agent.service.js";
import guardModule from "../dist/auth/token.guard.js";

const { SandboxesController } = controllerModule;

test("sandbox APIs authenticate, list owned containers, and stream read-only output", async (t) => {
  let listener;
  let unsubscribed = false;
  const shutdown = new AbortController();
  const agent = {
    shutdownSignal: shutdown.signal,
    sandboxMonitor: {
      async list() {
        return [
          {
            threadId: "chat-1",
            containerId: "abc",
            status: "running",
            lastUsedAt: new Date(0).toISOString(),
            expiredAt: null,
          },
        ];
      },
      async subscribe(id, callback) {
        if (id !== "chat-1") throw new Error("not found");
        listener = callback;
        return {
          snapshot: "previous\n",
          unsubscribe() {
            unsubscribed = true;
          },
        };
      },
    },
  };
  class TestModule {}
  Module({
    controllers: [SandboxesController],
    providers: [{ provide: agentModule.AgentService, useValue: agent }],
  })(TestModule);
  const previous = process.env.WINGMAN_API_TOKEN;
  process.env.WINGMAN_API_TOKEN = "sandbox-test-only";
  const app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalGuards(new guardModule.TokenGuard());
  await app.listen(0, "127.0.0.1");
  t.after(async () => {
    shutdown.abort();
    await app.close();
    if (previous === undefined) delete process.env.WINGMAN_API_TOKEN;
    else process.env.WINGMAN_API_TOKEN = previous;
  });
  const base = `${await app.getUrl()}/sandboxes`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: "Bearer sandbox-test-only" };
  const list = await fetch(base, { headers });
  assert.equal((await list.json()).sandboxes[0].threadId, "chat-1");
  assert.equal((await fetch(`${base}/other/output`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/chat-1/output`, { headers, method: "POST" })).status, 404);
  const abort = new AbortController();
  const stream = await fetch(`${base}/chat-1/output`, { headers, signal: abort.signal });
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /previous/);
  listener("live output\n");
  assert.match(decoder.decode((await reader.read()).value), /live output/);
  abort.abort();
  for (let i = 0; i < 20 && !unsubscribed; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(unsubscribed, true);
});
