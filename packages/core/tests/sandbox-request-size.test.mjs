import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerCommandExecutor } from "../src/capabilities/execution/sandbox/docker-command-executor.ts";

test("oversized sandbox scripts are rejected before acquiring sandbox state", async () => {
  const executor = new DockerCommandExecutor("postgres://invalid.invalid/no-database", "/unused");
  try {
    const result = await executor.executeShell("x".repeat(1024 * 1024), {
      threadId: "test-conversation",
      target: "sandbox",
      cwd: "/tmp",
    });
    assert.equal(result.failure, "access_denied");
    assert.match(result.error, /no command was sent/i);
  } finally {
    await executor.close();
  }
});
