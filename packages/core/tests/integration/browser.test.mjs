import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { McpConnectionManager } from "../../src/integrations/mcp/client.ts";
import { BrowserTools } from "../../src/integrations/browser/tools.ts";

test(
  "agent-browser isolates task sessions, returns explicit errors and cleans up only its owner",
  { timeout: 60000 },
  async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        `<html><head><title>Wingman ${request.url === "/a" ? "A" : "B"}</title></head><body><main><h1>Task ${request.url === "/a" ? "A" : "B"}</h1></main></body></html>`,
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const manager = new McpConnectionManager({
      agents: {
        browser: {
          mcpServers: {
            "agent-browser": {
              transport: "stdio",
              command: "agent-browser",
              args: [
                "mcp",
                "--config",
                fileURLToPath(new URL("../../../../agent-browser.json", import.meta.url)),
              ],
            },
          },
        },
      },
    });
    const browser = new BrowserTools(manager, "browser");
    const invoke = (name, args, thread) =>
      browser.tools
        .find((tool) => tool.name === name)
        .invoke(
          { type: "tool_call", id: `${name}-${thread}`, name, args },
          { configurable: { thread_id: thread }, signal: AbortSignal.timeout(15000) },
        );
    try {
      await browser.prepare();
      await assert.rejects(
        invoke("browser_open", { url: origin, session: "foreign" }, "integration-a"),
      );
      assert.equal(
        (await invoke("browser_open", { url: `${origin}/a` }, "integration-a")).status,
        "success",
      );
      assert.equal(
        (await invoke("browser_open", { url: `${origin}/b` }, "integration-b")).status,
        "success",
      );
      const rejected = await invoke(
        "browser_snapshot",
        { selector: "nonexistent-element" },
        "integration-a",
      );
      assert.equal(rejected.status, "error");
      assert.match(rejected.text, /did not match/);
      const snapshot = await invoke("browser_snapshot", { selector: "main" }, "integration-a");
      assert.equal(snapshot.status, "success");
      assert.match(snapshot.text, /Task A/);
      await browser.release("integration-a");
      const other = await invoke("browser_snapshot", { selector: "main" }, "integration-b");
      assert.equal(other.status, "success");
      assert.match(other.text, /Task B/);
    } finally {
      const cleanup = await Promise.allSettled([browser.close()]);
      await manager.close();
      await new Promise((resolve) => server.close(resolve));
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Browser integration cleanup failed");
    }
  },
);
