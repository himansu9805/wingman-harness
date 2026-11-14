import { sandboxExecutor } from "../../../tests/fixtures/sandbox-executor.mjs";
import { MemoryDelegationStore } from "../src/delegation/storage/store.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { CoreRuntime, initializeRuntime, closeRuntime } from "../src/runtime/runtime.ts";

function fixture({ closeMcp, ...overrides } = {}) {
  const calls = [];
  const saver = new MemorySaver();

  const dependencies = {
    async openMcp() {
      calls.push("tools");
      return {
        serverIds: ["openserp"],
        privateServerIds() {
          return [];
        },
        async getTools() {
          return [];
        },
        close:
          closeMcp ??
          (async () => {
            calls.push("close tools");
          }),
      };
    },
    async loadSkills() {
      calls.push("skills");
      return [{ name: "test", description: "Test skill", path: "/test/SKILL.md" }];
    },
    async loadConfiguration(skills) {
      calls.push("configuration");
      const { createLocalTools } = await import("../src/capabilities/catalogue.ts");
      const {
        createOrchestratorAgentDefinition,
        analystAgentDefinition,
        coderAgentDefinition,
        researcherAgentDefinition,
      } = await import("../src/agents/builtins/index.ts");
      const { fastModel, strongModel, modelRouter } =
        await import("../src/integrations/models/router.ts");
      return {
        definitions: [
          createOrchestratorAgentDefinition(),
          analystAgentDefinition,
          coderAgentDefinition,
          researcherAgentDefinition,
        ],
        globalTools: createLocalTools(skills, sandboxExecutor),
        models: { fast: fastModel, powerful: strongModel, routingMiddleware: modelRouter },
      };
    },
    async readSkill() {
      return "test content";
    },
    async openDelegations() {
      calls.push("delegations");
      const store = new MemoryDelegationStore();
      const close = store.close.bind(store);
      store.close = async () => {
        calls.push("close delegations");
        await close();
      };
      return store;
    },
    async openCheckpointer() {
      calls.push("checkpointer");

      return {
        saver,
        async close() {
          calls.push("close checkpointer");
        },
      };
    },
    async getMemoryIndex() {
      return "test memory";
    },
    async stopScheduler() {
      calls.push("stop scheduler");
    },
    async closeResults() {
      calls.push("close results");
    },
    async closeMemory() {
      calls.push("close memory");
    },
    ...overrides,
  };

  return { calls, saver, dependencies };
}

const cleanupOrder = [
  "stop scheduler",
  "close results",
  "close delegations",
  "close tools",
  "close checkpointer",
  "close memory",
];

test("shared resources close once in dependency order", async () => {
  const { calls, saver, dependencies } = fixture();
  const runtime = await CoreRuntime.create(dependencies);

  assert.equal(runtime.checkpointer, saver);
  assert.equal(runtime.skills[0].name, "test");
  assert.ok(Object.isFrozen(runtime.skills));
  assert.equal(await runtime.getMemoryIndex(), "test memory");

  const closing = runtime.close();

  assert.equal(runtime.close(), closing);
  await closing;

  assert.deepEqual(calls, [
    "tools",
    "skills",
    "configuration",
    "checkpointer",
    "delegations",
    ...cleanupOrder,
  ]);
  assert.throws(() => runtime.checkpointer, /closed/);
  assert.throws(() => runtime.getMemoryIndex(), /closed/);
});

test("failed initialization releases acquired resources", async () => {
  const failure = new Error("skills unavailable");
  const { calls, dependencies } = fixture({
    async loadSkills() {
      throw failure;
    },
  });

  await assert.rejects(CoreRuntime.create(dependencies), (error) => error === failure);

  assert.deepEqual(calls, [
    "tools",
    ...cleanupOrder.filter((name) => !["close checkpointer", "close delegations"].includes(name)),
  ]);
});

test("cleanup continues after failures and retains every error", async () => {
  const schedulerError = new Error("scheduler stop failed");
  const mcpError = new Error("MCP close failed");

  const { calls, dependencies } = fixture({
    async stopScheduler() {
      calls.push("stop scheduler");
      throw schedulerError;
    },
    async closeMcp() {
      calls.push("close tools");
      throw mcpError;
    },
  });

  const runtime = await CoreRuntime.create(dependencies);
  const closing = runtime.close();

  await assert.rejects(closing, (error) => {
    assert.deepEqual(error.errors, [schedulerError, mcpError]);
    return true;
  });

  assert.equal(runtime.close(), closing);
  assert.deepEqual(calls.slice(5), cleanupOrder);
});

test("startup and cleanup failures are both preserved", async () => {
  const startupError = new Error("checkpoint setup failed");
  const cleanupError = new Error("MCP close failed");

  const { dependencies } = fixture({
    async openCheckpointer() {
      throw startupError;
    },
    async closeMcp() {
      throw cleanupError;
    },
  });

  await assert.rejects(CoreRuntime.create(dependencies), (error) => {
    assert.equal(error.errors[0], startupError);
    assert.deepEqual(error.errors[1].errors, [cleanupError]);
    return true;
  });
});

test("scheduled turns retain memory access while draining", async () => {
  let runtime;

  const { calls, dependencies } = fixture({
    async stopScheduler() {
      assert.equal(await runtime.getMemoryIndex(), "test memory");
      calls.push("drained");
    },
  });

  runtime = await CoreRuntime.create(dependencies);
  await runtime.close();

  assert.ok(calls.indexOf("drained") < calls.indexOf("close memory"));
});

test("two agent graphs reuse the same checkpoint store", async () => {
  const { Agent } = await import("../src/agents/agent.ts");
  const { calls, dependencies } = fixture();
  const runtime = await CoreRuntime.create(dependencies);

  try {
    const first = await Agent.create(runtime);
    const second = await Agent.create(runtime);

    assert.notEqual(first.app, second.app);

    const config = {
      configurable: { thread_id: "shared-runtime-test" },
    };

    await first.app.graph.updateState(config, {
      messages: [{ role: "user", content: "persisted" }],
    });

    const state = await second.app.graph.getState(config);

    assert.equal(state.values.messages[0].content, "persisted");
    assert.deepEqual(calls, ["tools", "skills", "configuration", "checkpointer", "delegations"]);
  } finally {
    await runtime.close();
  }

  await assert.rejects(Agent.create(runtime), /closed/);
});

test("concurrent startup is shared and shutdown waits for it", async () => {
  const { calls, dependencies } = fixture();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const originalCreate = CoreRuntime.create;
  let startups = 0;

  CoreRuntime.create = async () => {
    startups++;
    await gate;
    return originalCreate.call(CoreRuntime, dependencies);
  };

  try {
    const first = initializeRuntime();
    assert.equal(initializeRuntime(), first);

    const closing = closeRuntime();
    assert.equal(closeRuntime(), closing);

    await assert.rejects(initializeRuntime(), /shutting down/);
    assert.deepEqual(calls, []);

    release();
    await closing;

    assert.equal(startups, 1);
    assert.deepEqual(calls, [
      "tools",
      "skills",
      "configuration",
      "checkpointer",
      "delegations",
      ...cleanupOrder,
    ]);

    const runtime = await first;
    assert.throws(() => runtime.assertOpen(), /closed/);
  } finally {
    CoreRuntime.create = originalCreate;
  }
});

test("registration failure releases the already acquired saver and MCP manager", async () => {
  const { calls, dependencies } = fixture();
  const load = dependencies.loadConfiguration;
  dependencies.loadConfiguration = async (skills) => {
    const configuration = await load(skills);
    return {
      ...configuration,
      definitions: [...configuration.definitions, configuration.definitions[0]],
    };
  };
  await assert.rejects(CoreRuntime.create(dependencies), /already registered/);
  assert.deepEqual(calls, [
    "tools",
    "skills",
    "configuration",
    "checkpointer",
    "delegations",
    ...cleanupOrder,
  ]);
});

test("configuration failure releases MCP without opening a checkpoint store", async () => {
  const failure = new Error("configuration unavailable");
  const { calls, dependencies } = fixture({
    async loadConfiguration() {
      throw failure;
    },
  });
  await assert.rejects(CoreRuntime.create(dependencies), (error) => error === failure);
  assert.deepEqual(calls, [
    "tools",
    "skills",
    ...cleanupOrder.filter((name) => !["close checkpointer", "close delegations"].includes(name)),
  ]);
});
