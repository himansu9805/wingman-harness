import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAgent, assembleAgentModules } from "../src/agents/module.ts";
import { createOrchestratorAgentDefinition } from "../src/agents/builtins/orchestrator.ts";
import { builtinAgentModules } from "../src/agents/builtins/index.ts";
import { analystAgentDefinition } from "../src/agents/builtins/analyst.ts";
import { researcherAgentDefinition } from "../src/agents/builtins/researcher.ts";
import { workerBudget } from "../src/delegation/budgets.ts";

const reviewer = () =>
  defineAgent({
    id: "reviewer",
    description: "Reviews findings",
    instructions: "Review only supplied evidence",
    delegatedBy: ["orchestrator"],
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
  const parent = createOrchestratorAgentDefinition();
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
  const parent = createOrchestratorAgentDefinition();
  const researchDefinition = researcherAgentDefinition;
  assert.deepEqual(workerBudget(parent, researchDefinition), {
    timeoutMs: 120000,
    maxModelCalls: 24,
  });
  assert.deepEqual(workerBudget(parent, analystAgentDefinition), {
    timeoutMs: 30000,
    maxModelCalls: 8,
  });
  parent.delegation.timeoutMs = 10000;
  parent.delegation.maxModelCalls = 2;
  assert.deepEqual(workerBudget(parent, researchDefinition), {
    timeoutMs: 10000,
    maxModelCalls: 2,
  });
});

test("researcher selects only shared OpenSERP tools without shell, memory or nested delegation", () => {
  const configuration = assembleAgentModules(builtinAgentModules(false));
  const researcher = configuration.definitions.find((definition) => definition.id === "researcher");
  assert(configuration.definitions[0].delegation.agents.includes("researcher"));
  assert.equal(researcher.model, "powerful");
  assert.deepEqual(researcher.delegation.agents, []);
  assert.deepEqual(researcher.capabilities, {
    useGlobalTools: [],
    tools: [],
    useGlobalMcpServers: [
      {
        serverId: "openserp",
        tools: ["any_search", "extract", "batch_extract", "list_engines"],
      },
    ],
    mcp: [],
    skills: [],
    memory: "none",
  });
});

test("orchestrator explicitly declares every built-in specialist before module assembly", () => {
  const definition = createOrchestratorAgentDefinition();
  assert.deepEqual(definition.delegation.agents, ["analyst", "operator", "researcher"]);
  const assembled = assembleAgentModules(builtinAgentModules(false));
  assert.deepEqual(assembled.definitions[0].delegation.agents, definition.delegation.agents);
});
