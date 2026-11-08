import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAgent, assembleAgentModules } from "../src/agents/module.ts";
import { createDefaultAgentDefinition } from "../src/agents/builtins/coordinator.ts";
import { browserAgentDefinition } from "../src/agents/builtins/browser.ts";
import { analystAgentDefinition } from "../src/agents/builtins/analyst.ts";
import { workerBudget } from "../src/delegation/budgets.ts";

const reviewer = () =>
  defineAgent({
    id: "reviewer",
    description: "Reviews findings",
    instructions: "Review only supplied evidence",
    delegatedBy: ["default"],
  });

test("a minimal agent module has no implicit tools, MCP, skills or memory", () => {
  const { definition } = reviewer();
  assert.equal(definition.model, "powerful");
  assert.deepEqual(definition.capabilities, {
    useGlobalTools: [],
    tools: [],
    useGlobalMcpServers: [],
    mcp: [],
    skills: [],
    memory: "none",
  });
});

test("one module registration wires delegation without mutating the coordinator definition", () => {
  const parent = createDefaultAgentDefinition();
  const configuration = assembleAgentModules([{ definition: parent }, reviewer()]);
  assert(configuration.definitions[0].delegation.agents.includes("reviewer"));
  assert(!parent.delegation.agents.includes("reviewer"));
  assert.deepEqual(configuration.agentTools.reviewer, []);
});

test("duplicate modules, unknown coordinators and self-delegation fail assembly", () => {
  assert.throws(() => assembleAgentModules([reviewer(), reviewer()]), /unique/);
  assert.throws(() => assembleAgentModules([reviewer()]), /Unknown delegating/);
  assert.throws(
    () =>
      assembleAgentModules([
        defineAgent({
          id: "self",
          description: "Self",
          instructions: "Test",
          delegatedBy: ["self"],
        }),
      ]),
    /itself/,
  );
});

test("worker-specific budgets are bounded by the coordinator, not applied to every role", () => {
  const parent = createDefaultAgentDefinition();
  assert.deepEqual(workerBudget(parent, browserAgentDefinition), {
    timeoutMs: 120000,
    maxModelCalls: 12,
  });
  assert.deepEqual(workerBudget(parent, analystAgentDefinition), {
    timeoutMs: 30000,
    maxModelCalls: 8,
  });
  parent.delegation.timeoutMs = 10000;
  parent.delegation.maxModelCalls = 2;
  assert.deepEqual(workerBudget(parent, browserAgentDefinition), {
    timeoutMs: 10000,
    maxModelCalls: 2,
  });
});
