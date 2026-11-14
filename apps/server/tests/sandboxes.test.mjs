import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import controllerModule from "../dist/sandboxes/sandboxes.controller.js";
import agentModule from "../dist/agent/agent.service.js";
import guardModule from "../dist/auth/token.guard.js";

const { SandboxesController } = controllerModule;

test("sandbox APIs authenticate, list owned containers, and manage lifecycle", async (t) => {
  const shutdown = new AbortController();
  const agent = {
    shutdownSignal: shutdown.signal,
    sandboxMonitor: {
      async list() {
        return [
          {
            threadId: "chat-1",
            name: "Falcon-a1b2c3d4e5f6",
            containerId: "abc",
            status: "running",
            lastUsedAt: new Date(0).toISOString(),
            expiredAt: null,
          },
        ];
      },
      async stop(id) {
        return id === "chat-1";
      },
      async release(id) {
        assert.equal(id, "chat-1");
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
  const sandbox = (await list.json()).sandboxes[0];
  assert.equal(sandbox.threadId, "chat-1");
  assert.equal(sandbox.name, "Falcon-a1b2c3d4e5f6");
  assert.equal((await fetch(`${base}/chat-1/stop`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/chat-1/stop`, { headers, method: "POST" })).status, 201);
  assert.equal((await fetch(`${base}/other/stop`, { headers, method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/chat-1`, { headers, method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/chat-1/output`, { headers })).status, 404);
});
