import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRegistry } from "../src/core/agents/registry.ts";
import {
  defaultAgentDefinition,
  analystAgentDefinition,
} from "../src/core/agents/defaults.ts";

function registry() {
  return new AgentRegistry({
    localTools: ["load_skill", "recall_memory"],
    mcpTools: ["browser_snapshot"],
    skills: ["review"],
  });
}

test("registers default and specialist definitions", () => {
  const agents = registry();

  agents.register(defaultAgentDefinition);
  agents.register(analystAgentDefinition);

  assert.equal(agents.get("default").model, "routed");
  assert.equal(agents.get("analyst").capabilities.memory, "none");
  assert.equal(agents.list().length, 2);
});

test("rejects duplicate and unknown agent IDs", () => {
  const agents = registry();

  agents.register(analystAgentDefinition);

  assert.throws(
    () => agents.register(analystAgentDefinition),
    /already registered/,
  );
  assert.throws(() => agents.get("missing"), /Unknown agent/);
});

test("rejects malformed definitions and duplicate capabilities", () => {
  const agents = registry();

  assert.throws(() =>
    agents.register({
      ...analystAgentDefinition,
      id: "Invalid ID",
    }),
  );

  assert.throws(() =>
    agents.register({
      ...analystAgentDefinition,
      capabilities: {
        ...analystAgentDefinition.capabilities,
        localTools: ["load_skill", "load_skill"],
      },
    }),
  );
});

test("rejects unavailable capabilities in each category", () => {
  for (const category of ["localTools", "mcpTools", "skills"]) {
    assert.throws(
      () =>
        registry().register({
          ...analystAgentDefinition,
          capabilities: {
            ...analystAgentDefinition.capabilities,
            [category]: ["missing"],
          },
        }),
      /unknown .* capability/,
    );
  }
});

test("registered definitions cannot be changed through caller references", () => {
  const agents = registry();
  const input = {
    ...analystAgentDefinition,
    capabilities: {
      ...analystAgentDefinition.capabilities,
      localTools: ["load_skill"],
    },
  };

  const registered = agents.register(input);

  input.capabilities.localTools.push("recall_memory");
  input.instructions = "changed";

  assert.deepEqual(registered.capabilities.localTools, ["load_skill"]);
  assert.notEqual(registered.instructions, "changed");

  assert.throws(() => {
    registered.capabilities.localTools.push("recall_memory");
  }, TypeError);
});

test("rejects ambiguous tool names and duplicate catalogue entries", () => {
  assert.throws(
    () =>
      new AgentRegistry({
        localTools: ["same"],
        mcpTools: ["same"],
        skills: [],
      }),
    /shared by local and MCP/,
  );

  assert.throws(
    () =>
      new AgentRegistry({
        localTools: ["same", "same"],
        mcpTools: [],
        skills: [],
      }),
    /Duplicate names/,
  );
});
