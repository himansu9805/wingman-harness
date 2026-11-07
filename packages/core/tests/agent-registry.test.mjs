import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRegistry } from "../src/core/agents/registry.ts";
import { createDefaultAgentDefinition, analystAgentDefinition } from "../src/core/agents/defaults.ts";
import { AgentToolCatalogue } from "../src/core/agents/catalogue.ts";

function registry() {
  return new AgentRegistry({
    localTools: ["read_file", "write_file"],
    mcpServers: ["docs", "search"],
    skills: ["review"],
    agents: {
      analyst: { tools: ["analyze"], mcpServers: ["private-docs"] },
      developer: { tools: ["run_tests"], mcpServers: ["github"] },
    },
  });
}

function definition(capabilities = {}) {
  return {
    ...analystAgentDefinition,
    capabilities: { ...analystAgentDefinition.capabilities, ...capabilities },
  };
}

test("empty or omitted selections do not inherit global capabilities", () => {
  const input = definition();
  delete input.capabilities.useGlobalTools;
  delete input.capabilities.tools;
  delete input.capabilities.useGlobalMcpServers;
  delete input.capabilities.mcp;
  const registered = registry().register(input);
  assert.deepEqual(registered.capabilities.useGlobalTools, []);
  assert.deepEqual(registered.capabilities.tools, []);
  assert.deepEqual(registered.capabilities.useGlobalMcpServers, []);
  assert.deepEqual(registered.capabilities.mcp, []);
});

test("agents explicitly select global capabilities and their own private additions", () => {
  const registered = registry().register(definition({
    useGlobalTools: ["read_file"], tools: ["analyze"],
    useGlobalMcpServers: [{ serverId: "docs", tools: ["search"] }],
    mcp: [{ serverId: "private-docs", tools: "all" }],
  }));
  assert.deepEqual(registered.capabilities.useGlobalTools, ["read_file"]);
  assert.deepEqual(registered.capabilities.tools, ["analyze"]);
  assert.deepEqual(registered.capabilities.useGlobalMcpServers, [{ serverId: "docs", tools: ["search"] }]);
});

test("agents cannot select another agent's private tools or servers", () => {
  assert.throws(() => registry().register(definition({ tools: ["run_tests"] })), /Unknown private tool/);
  assert.throws(() => registry().register(definition({ mcp: [{ serverId: "github", tools: "all" }] })), /unknown private MCP server/);
  assert.throws(() => registry().register(definition({ useGlobalTools: ["analyze"] })), /unknown localTools capability/);
  assert.throws(() => registry().register(definition({ useGlobalMcpServers: [{ serverId: "private-docs", tools: "all" }] })), /unknown global MCP server/);
});

test("malformed, duplicate and unavailable selections fail validation", () => {
  for (const capabilities of [
    { useGlobalTools: "all" }, { useGlobalTools: ["read_file", "read_file"] },
    { useGlobalMcpServers: [{ serverId: "docs", tools: "all" }, { serverId: "docs", tools: [] }] },
    { useGlobalMcpServers: [{ serverId: "docs", tools: ["search", "search"] }] },
    { useGlobalTools: ["missing"] }, { skills: ["missing"] },
  ]) assert.throws(() => registry().register(definition(capabilities)));
  assert.throws(() => registry().register({ ...definition(), id: "Invalid ID" }));
  const agents = registry();
  agents.register(definition());
  assert.throws(() => agents.register(definition()), /already registered/);
  assert.throws(() => agents.get("missing"), /Unknown agent/);
});

test("registered selections are immutable snapshots", () => {
  const input = definition({
    useGlobalTools: ["read_file"], tools: ["analyze"],
    useGlobalMcpServers: [{ serverId: "docs", tools: ["search"] }],
    mcp: [{ serverId: "private-docs", tools: ["fetch"] }],
  });
  const registered = registry().register(input);
  input.capabilities.useGlobalTools.push("write_file");
  input.capabilities.useGlobalMcpServers[0].tools.push("write");
  input.capabilities.mcp[0].tools.push("write");
  assert.deepEqual(registered.capabilities.useGlobalTools, ["read_file"]);
  assert.deepEqual(registered.capabilities.useGlobalMcpServers[0].tools, ["search"]);
  assert.deepEqual(registered.capabilities.mcp[0].tools, ["fetch"]);
  assert.throws(() => registered.capabilities.tools.push("other"), TypeError);
  assert.throws(() => registered.capabilities.mcp[0].tools.push("other"), TypeError);
});

test("tool catalogue resolves only selected global and owning-agent tools", () => {
  const read = { name: "read_file" }; const write = { name: "write_file" };
  const analyze = { name: "analyze" }; const run = { name: "run_tests" };
  const catalogue = new AgentToolCatalogue([read, write], { analyst: [analyze], developer: [run] });
  assert.deepEqual(catalogue.resolve("analyst", [], []), []);
  assert.deepEqual(catalogue.resolve("analyst", ["read_file"], ["analyze"]), [read, analyze]);
  assert.throws(() => catalogue.resolve("analyst", [], ["run_tests"]), /Unknown agent/);
  assert.throws(() => catalogue.resolve("analyst", ["run_tests"], []), /Unknown global/);
});

test("adding global tools never expands an existing explicit selection", () => {
  const read = { name: "read_file" }; const write = { name: "write_file" };
  assert.deepEqual(new AgentToolCatalogue([read, write]).resolve("analyst", ["read_file"], []), [read]);
});

test("ambiguous names and duplicate catalogue entries fail instead of overriding", () => {
  assert.throws(() => new AgentRegistry({ localTools: ["same", "same"], mcpServers: [], skills: [] }), /Duplicate names/);
  const catalogue = new AgentToolCatalogue([{ name: "same" }], { analyst: [{ name: "same" }] });
  assert.throws(() => catalogue.resolve("analyst", ["same"], ["same"]), /Duplicate tool name/);
});

test("default baseline has explicit tool names and no automatic global MCP grants", () => {
  const basic = createDefaultAgentDefinition();
  const scheduled = createDefaultAgentDefinition(true);
  assert.ok(basic.capabilities.useGlobalTools.includes("exec_bash_command"));
  assert.ok(!basic.capabilities.useGlobalTools.includes("schedule_task"));
  assert.ok(scheduled.capabilities.useGlobalTools.includes("schedule_task"));
  assert.deepEqual(basic.capabilities.useGlobalMcpServers, []);
  assert.deepEqual(basic.capabilities.mcp, []);
});
