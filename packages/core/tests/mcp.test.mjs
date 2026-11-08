import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { McpConnectionManager, openMcpConnections } from "../src/mcp/mcp.ts";

function getGlobalTools(manager, grants) {
  return manager.getTools("default", { useGlobalMcpServers: grants, mcp: [] });
}

function fixture(overrides = {}) {
  const opened = [];
  const closed = [];
  const invoked = [];
  const factory = (profileId, configuration) => {
    const serverId = profileId.slice("global__".length);
    assert.equal(configuration.headers["X-Test-Identity"], serverId);
    opened.push(serverId);
    return {
      async getTools() {
        if (overrides.discover) return overrides.discover(serverId);
        return ["search", "write"].map((name) =>
          tool(
            async () => {
              invoked.push({ serverId, name });
              return serverId;
            },
            {
              name: `mcp__${profileId}__${name}`,
              description: `${name} on ${serverId}`,
              schema: z.object({}),
            },
          ),
        );
      },
      async close() {
        closed.push(serverId);
        if (overrides.close) await overrides.close(serverId);
      },
    };
  };
  const manager = new McpConnectionManager(
    {
      mcpServers: {
        docs: { url: "https://example.invalid/mcp", headers: { "X-Test-Identity": "docs" } },
        "github-read": {
          url: "https://example.invalid/mcp",
          headers: { "X-Test-Identity": "github-read" },
        },
      },
    },
    factory,
  );
  return { manager, opened, closed, invoked };
}

test("agent grants connect only selected profiles and expose only selected tools", async () => {
  const { manager, opened, invoked } = fixture();
  try {
    assert.deepEqual(await getGlobalTools(manager, []), []);
    assert.deepEqual(await getGlobalTools(manager, [{ serverId: "github-read", tools: [] }]), []);
    assert.deepEqual(opened, []);
    const tools = await getGlobalTools(manager, [{ serverId: "docs", tools: ["search"] }]);
    assert.deepEqual(opened, ["docs"]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["mcp__global__docs__search"],
    );
    assert.equal(await tools[0].invoke({}), "docs");
    assert.deepEqual(invoked, [{ serverId: "docs", name: "search" }]);
  } finally {
    await manager.close();
  }
});

test("concurrent agents share a profile without sharing their granted tool lists", async () => {
  const { manager, opened, closed } = fixture();
  const [first, second] = await Promise.all([
    getGlobalTools(manager, [{ serverId: "docs", tools: ["search"] }]),
    getGlobalTools(manager, [{ serverId: "docs", tools: ["write"] }]),
  ]);
  assert.deepEqual(opened, ["docs"]);
  assert.deepEqual(
    first.map((tool) => tool.name),
    ["mcp__global__docs__search"],
  );
  assert.deepEqual(
    second.map((tool) => tool.name),
    ["mcp__global__docs__write"],
  );
  first.length = 0;
  assert.equal(second.length, 1);
  const closing = manager.close();
  assert.equal(manager.close(), closing);
  await closing;
  assert.deepEqual(closed, ["docs"]);
  await assert.rejects(getGlobalTools(manager, []), /closing/);
});

test("separate profiles retain distinct clients and namespaces even for the same URL", async () => {
  const { manager, opened, closed } = fixture();
  const tools = await getGlobalTools(manager, [
    { serverId: "docs", tools: ["search"] },
    { serverId: "github-read", tools: ["search"] },
  ]);
  assert.deepEqual(opened, ["docs", "github-read"]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["mcp__global__docs__search", "mcp__global__github-read__search"],
  );
  assert.deepEqual(await Promise.all(tools.map((tool) => tool.invoke({}))), [
    "docs",
    "github-read",
  ]);
  await manager.close();
  assert.deepEqual(closed, opened);
});

test("unknown servers and duplicate grants fail before opening any client", async () => {
  const { manager, opened } = fixture();
  await assert.rejects(
    getGlobalTools(manager, [
      { serverId: "docs", tools: "all" },
      { serverId: "missing", tools: "all" },
    ]),
    /Unknown MCP server/,
  );
  await assert.rejects(
    getGlobalTools(manager, [
      { serverId: "docs", tools: "all" },
      { serverId: "docs", tools: ["search"] },
    ]),
    /MCP server grants must be unique/,
  );
  assert.deepEqual(opened, []);
  await manager.close();
});

test("unknown tools do not fall back to a different profile", async () => {
  const { manager, opened } = fixture();
  await assert.rejects(
    getGlobalTools(manager, [{ serverId: "docs", tools: ["missing"] }]),
    /Unknown MCP tool/,
  );
  assert.deepEqual(opened, ["docs"]);
  await manager.close();
});

test("duplicate tools and incorrect namespaces are rejected", async () => {
  for (const names of [
    ["mcp__global__docs__search", "mcp__global__docs__search"],
    ["mcp__global__github-read__search"],
  ]) {
    const { manager, closed } = fixture({
      async discover() {
        return names.map((name) => ({ name }));
      },
    });
    await assert.rejects(
      getGlobalTools(manager, [{ serverId: "docs", tools: "all" }]),
      /Duplicate MCP tool|Invalid tool namespace/,
    );
    await manager.close();
    assert.deepEqual(closed, ["docs"]);
  }
});

test("failed discovery is retained and partially opened clients are still closed", async () => {
  const { manager, opened, closed } = fixture({
    async discover() {
      throw new Error("private credential");
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(getGlobalTools(manager, [{ serverId: "docs", tools: "all" }]), (error) => {
      assert.equal(error.message, 'Failed to discover tools for MCP server "global__docs"');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(opened, ["docs"]);
  await manager.close();
  assert.deepEqual(closed, ["docs"]);
});

test("shutdown waits for discovery and attempts all clients even if cleanup fails", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { manager, closed } = fixture({
    async discover() {
      await gate;
      return [];
    },
    async close(serverId) {
      if (serverId === "docs") throw new Error("private credential");
    },
  });
  const discovery = getGlobalTools(manager, [
    { serverId: "docs", tools: "all" },
    { serverId: "github-read", tools: "all" },
  ]);
  const rejectedDiscovery = assert.rejects(discovery, /closing/);
  const closing = manager.close();
  const rejectedClose = assert.rejects(closing, (error) => {
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].message, 'Failed to close MCP server "global__docs"');
    return true;
  });
  assert.deepEqual(closed, []);
  release();
  await Promise.all([rejectedDiscovery, rejectedClose]);
  assert.deepEqual(closed, ["docs", "github-read"]);
  assert.equal(manager.close(), closing);
});

test("connection configuration errors do not expose credentials", async () => {
  const manager = new McpConnectionManager({ mcpServers: { docs: {} } }, () => {
    throw new Error("private credential");
  });
  await assert.rejects(getGlobalTools(manager, [{ serverId: "docs", tools: "all" }]), (error) => {
    assert.equal(error.message, 'Invalid MCP connection configuration for server "global__docs"');
    return true;
  });
  await manager.close();
});

test("configuration files allow absence but reject invalid JSON and malformed profiles", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wingman-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "mcp.config.json");
  const empty = await openMcpConnections(path);
  assert.deepEqual(empty.serverIds, []);
  await empty.close();
  await writeFile(path, "{private credential");
  await assert.rejects(openMcpConnections(path), /contains invalid JSON/);
  await writeFile(path, JSON.stringify({ mcpServers: { invalid__id: {} } }));
  await assert.rejects(openMcpConnections(path), /Invalid MCP configuration/);
  const invalid = new McpConnectionManager({ mcpServers: { docs: { command: 7 } } });
  await assert.rejects(
    getGlobalTools(invalid, [{ serverId: "docs", tools: "all" }]),
    /Invalid MCP connection configuration/,
  );
  await invalid.close();
});

test("installed adapter namespaces real stdio tools and routes calls to their owning profile", async () => {
  // A tiny JSON-RPC fixture exercises the installed adapter without external MCP services.
  const server = `
    const readline = require('node:readline');
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1.0' },
      };
      else if (request.method === 'tools/list') result = { tools: [{
        name: 'search', description: 'Test search', inputSchema: { type: 'object', properties: {} },
      }] };
      else if (request.method === 'tools/call') result = {
        content: [{ type: 'text', text: 'called ' + process.argv[1] }],
      };
      else result = {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `;
  const manager = new McpConnectionManager({
    mcpServers: Object.fromEntries(
      ["docs", "github-read"].map((id) => [
        id,
        { command: process.execPath, args: ["-e", server, id] },
      ]),
    ),
  });
  try {
    const tools = await getGlobalTools(manager, [
      { serverId: "docs", tools: ["search"] },
      { serverId: "github-read", tools: ["search"] },
    ]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["mcp__global__docs__search", "mcp__global__github-read__search"],
    );
    assert.match(JSON.stringify(await tools[0].invoke({})), /called docs/);
    assert.match(JSON.stringify(await tools[1].invoke({})), /called github-read/);
  } finally {
    await manager.close();
  }
});

test("global profiles are opt-in and shared, while agent profiles stay private", async () => {
  const opened = [];
  const closed = [];
  const manager = new McpConnectionManager(
    {
      mcpServers: {
        docs: { identity: "shared docs" },
        search: { identity: "shared search" },
      },
      agents: {
        developer: { mcpServers: { docs: { identity: "developer docs" } } },
        researcher: { mcpServers: { search: { identity: "researcher search" } } },
      },
    },
    (profileId, configuration) => {
      opened.push(profileId);
      return {
        async getTools() {
          return [
            tool(async () => configuration.identity, {
              name: `mcp__${profileId}__fetch`,
              description: "Test fetch",
              schema: z.object({}),
            }),
          ];
        },
        async close() {
          closed.push(profileId);
        },
      };
    },
  );
  try {
    const none = { useGlobalMcpServers: [], mcp: [] };
    assert.deepEqual(await manager.getTools("developer", none), []);
    assert.deepEqual(opened, []);
    assert.deepEqual(manager.privateServerIds("developer"), ["docs"]);
    assert.deepEqual(manager.privateServerIds("unknown"), []);

    const developer = await manager.getTools("developer", {
      useGlobalMcpServers: [{ serverId: "docs", tools: ["fetch"] }],
      mcp: [{ serverId: "docs", tools: ["fetch"] }],
    });
    const researcher = await manager.getTools("researcher", {
      useGlobalMcpServers: [{ serverId: "docs", tools: ["fetch"] }],
      mcp: [{ serverId: "search", tools: ["fetch"] }],
    });
    assert.equal(developer[0], researcher[0]);
    assert.deepEqual(
      developer.map((tool) => tool.name),
      ["mcp__global__docs__fetch", "mcp__agent__developer__docs__fetch"],
    );
    assert.deepEqual(await Promise.all(developer.map((tool) => tool.invoke({}))), [
      "shared docs",
      "developer docs",
    ]);
    assert.deepEqual(await Promise.all(researcher.map((tool) => tool.invoke({}))), [
      "shared docs",
      "researcher search",
    ]);
    await assert.rejects(
      manager.getTools("developer", {
        useGlobalMcpServers: [],
        mcp: [{ serverId: "search", tools: "all" }],
      }),
      /Unknown MCP server/,
    );
    assert.deepEqual(opened, [
      "global__docs",
      "agent__developer__docs",
      "agent__researcher__search",
    ]);
    assert.ok(!opened.includes("global__search"));
  } finally {
    await manager.close();
  }
  assert.deepEqual(closed, opened);
});
