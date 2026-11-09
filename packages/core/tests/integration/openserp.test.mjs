import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { McpConnectionManager } from "../../src/integrations/mcp/client.ts";
import { researcherAgentDefinition } from "../../src/agents/builtins/researcher.ts";
import { createOrchestratorAgentDefinition } from "../../src/agents/builtins/orchestrator.ts";

test(
  "official OpenSERP MCP searches and extracts through the shared researcher grant",
  { timeout: 30000 },
  async () => {
    const requests = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://fixture");
      requests.push({ path: url.pathname, query: url.searchParams });
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/mega/search") {
        response.end(
          JSON.stringify([
            {
              rank: 1,
              title: "Fixture report",
              url: "https://example.invalid/report",
              description: "A source lead",
              type: "organic",
            },
          ]),
        );
      } else if (url.pathname === "/extract" && url.searchParams.get("url").includes("missing")) {
        response.writeHead(503);
        response.end(JSON.stringify({ error: "Fixture source unavailable" }));
      } else if (url.pathname === "/extract") {
        response.end(
          JSON.stringify({
            url: url.searchParams.get("url"),
            title: "Fixture report",
            markdown: "Published 2026-11-08. Verified fixture text. ".repeat(100),
            text: "Fixture source",
            links: [],
          }),
        );
      } else if (url.pathname === "/extract/batch") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { urls } = JSON.parse(body);
        response.end(
          JSON.stringify(
            urls.map((url, index) => ({
              page_content: index ? "" : "Fixture report",
              metadata: {
                source: url,
                ...(index ? { error: "Unavailable" } : { title: "Fixture report" }),
              },
            })),
          ),
        );
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "Unknown fixture endpoint" }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const manager = new McpConnectionManager({
      mcpServers: {
        openserp: {
          transport: "stdio",
          command: "npx",
          args: ["--no-install", "openserp-mcp", "--stdio"],
          env: {
            OPENSERP_BACKEND: "oss",
            OPENSERP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          },
        },
      },
    });
    try {
      assert.deepEqual(
        await manager.getTools("orchestrator", createOrchestratorAgentDefinition().capabilities),
        [],
      );
      assert.equal(requests.length, 0);
      const tools = await manager.getTools("researcher", researcherAgentDefinition.capabilities);
      assert.equal(tools.length, 4);
      const invoke = (name, args) => {
        const selected = tools.find((tool) => tool.name === `mcp__global__openserp__${name}`);
        return selected.invoke(
          { type: "tool_call", id: name, name: selected.name, args },
          { signal: AbortSignal.timeout(5000) },
        );
      };
      const search = await invoke("any_search", {
        engines: ["bing"],
        text: "fixture report",
        limit: 3,
      });
      assert.equal(search.status, "success");
      assert.match(search.text, /https:\/\/example.invalid\/report/);
      assert.equal(requests[0].query.get("text"), "fixture report");
      const source = await invoke("extract", {
        url: "https://example.invalid/report",
        maxChars: 500,
      });
      assert.equal(source.status, "success");
      assert.match(source.text, /2026-11-08/);
      assert.match(source.text, /truncated/);
      const batch = await invoke("batch_extract", {
        urls: ["https://example.invalid/report", "https://example.invalid/missing"],
      });
      assert.equal(batch.status, "success");
      assert.match(batch.text, /Unavailable/);
      const unavailable = await invoke("extract", { url: "https://example.invalid/missing" });
      assert.equal(unavailable.status, "error");
      assert.match(unavailable.text, /503/);
      assert.equal(
        requests.filter(
          (request) => request.path === "/extract" && request.query.get("url").includes("missing"),
        ).length,
        1,
      );
    } finally {
      await manager.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
