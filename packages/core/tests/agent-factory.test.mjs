import { MemoryDelegationStore } from "../src/delegation/storage/store.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { Agent } from "../src/agents/agent.ts";
import { CoreRuntime } from "../src/runtime/runtime.ts";
import {
  analystAgentDefinition,
  operatorAgentDefinition,
  researcherAgentDefinition,
  createOrchestratorAgentDefinition,
} from "../src/agents/builtins/index.ts";
import { createLocalTools, createLoadSkillTool } from "../src/capabilities/catalogue.ts";
import { startTurn, resumeTurn } from "../src/conversations/turn.ts";
import { GraphMemory } from "../src/memory/graph.ts";
import { buildSystemPrompt } from "../src/agents/prompt.ts";

class RecordingModel extends BaseChatModel {
  constructor(label, trace, respond, boundTools = []) {
    super({});
    Object.assign(this, { label, trace, respond, boundTools });
  }
  _llmType() {
    return "agent-factory-test";
  }
  bindTools(tools) {
    return new RecordingModel(this.label, this.trace, this.respond, tools);
  }
  async _generate(messages) {
    this.trace.models.push({
      label: this.label,
      prompt: messages
        .filter(SystemMessage.isInstance)
        .map((message) => message.text)
        .join("\n"),
      tools: this.boundTools.map((tool) => tool.name),
      messages,
    });
    const message = this.respond ? await this.respond(messages) : new AIMessage(this.label);
    return { generations: [{ text: message.text, message }] };
  }
}

const options = () => ({ signal: AbortSignal.timeout(10_000) });
const role = (id, capabilities = {}, model = "powerful") => ({
  ...analystAgentDefinition,
  id,
  model,
  instructions: `Instructions for ${id}.`,
  capabilities: { ...analystAgentDefinition.capabilities, ...capabilities },
});
const simpleTool = (name) =>
  tool(async () => name, { name, description: name, schema: z.object({}) });

async function fixture({
  definitions,
  globalTools = [],
  agentTools = {},
  skills = [],
  respond,
  mcpTools = [],
} = {}) {
  const trace = { models: [], routing: 0, memory: 0, mcp: [], skills: [], closed: [] };
  const fast = new RecordingModel("fast", trace, respond);
  const powerful = new RecordingModel("powerful", trace, respond);
  const routingMiddleware = createMiddleware({
    name: "TestRouter",
    wrapModelCall: async (request, handler) => {
      trace.routing++;
      return handler({ ...request, model: fast });
    },
  });
  const saver = new MemorySaver();
  const runtime = await CoreRuntime.create({
    async openMcp() {
      return {
        serverIds: ["docs", "openserp"],
        privateServerIds(id) {
          return id === "developer" ? ["github"] : [];
        },
        async getTools(id, access) {
          trace.mcp.push({ id, access });
          return mcpTools;
        },
        async close() {
          trace.closed.push("mcp");
        },
      };
    },
    async loadSkills() {
      return skills;
    },
    async openDelegations() {
      return new MemoryDelegationStore();
    },
    async loadConfiguration() {
      return {
        definitions: definitions ?? [role("orchestrator", {}, "routed"), role("analyst")],
        globalTools,
        agentTools,
        models: { fast, powerful, routingMiddleware },
      };
    },
    async readSkill(skill) {
      trace.skills.push(skill.name);
      return `instructions: ${skill.name}`;
    },
    async openCheckpointer() {
      return {
        saver,
        async close() {
          trace.closed.push("checkpointer");
        },
      };
    },
    async getMemoryIndex() {
      trace.memory++;
      return "PRIVATE MEMORY: User preferences";
    },
    async stopScheduler() {},
    async closeResults() {},
    async closeMemory() {},
  });
  return { runtime, trace, saver };
}

test("default and specialist use distinct prompts, models and tools on one runtime", async () => {
  const { runtime, trace } = await fixture({
    definitions: [
      role("orchestrator", { useGlobalTools: ["read_file"] }, "routed"),
      role("analyst"),
    ],
    globalTools: [simpleTool("read_file"), simpleTool("write_file")],
  });
  try {
    const general = await Agent.create(runtime);
    const specialist = await Agent.create(runtime, "analyst");
    assert.equal(general.id, "orchestrator");
    assert.equal(specialist.id, "analyst");
    assert.equal(
      (await startTurn(general, "general input", "general-thread", options())).text,
      "fast",
    );
    assert.equal(
      (await startTurn(specialist, "analysis input", "analyst-thread", options())).text,
      "powerful",
    );
    assert.equal(trace.routing, 1);
    assert.deepEqual(trace.models[0].tools, ["read_file"]);
    assert.deepEqual(trace.models[1].tools, []);
    assert.match(trace.models[0].prompt, /Instructions for orchestrator/);
    assert.match(trace.models[1].prompt, /Instructions for analyst/);
    assert.doesNotMatch(
      trace.models[1].prompt,
      /Instructions for orchestrator|PRIVATE MEMORY|# Memory|# Scheduling|# Shell|# Skills/,
    );
    assert.equal(trace.memory, 0);
    assert.ok(!trace.models[1].messages.some((message) => message.text === "general input"));
    assert.equal(runtime.checkpointer instanceof MemorySaver, true);
  } finally {
    await runtime.close();
  }
});

test("fixed fast and powerful agents never invoke routing", async () => {
  const { runtime, trace } = await fixture({
    definitions: [role("orchestrator", {}, "fast"), role("analyst")],
  });
  try {
    await startTurn(await Agent.create(runtime), "hello", "fast-thread", options());
    await startTurn(await Agent.create(runtime, "analyst"), "hello", "powerful-thread", options());
    assert.deepEqual(
      trace.models.map((call) => call.label),
      ["fast", "powerful"],
    );
    assert.equal(trace.routing, 0);
  } finally {
    await runtime.close();
  }
});

test("unknown agent fails before MCP discovery or model invocation", async () => {
  const { runtime, trace } = await fixture();
  try {
    await assert.rejects(Agent.create(runtime, "missing"), /Unknown agent/);
    assert.deepEqual(trace.mcp, []);
    assert.deepEqual(trace.models, []);
  } finally {
    await runtime.close();
  }
});

test("read-only memory exposes the index and recall without write instructions", async () => {
  const { runtime, trace } = await fixture({
    definitions: [role("orchestrator", { memory: "read", useGlobalTools: ["recall_memory"] })],
    globalTools: [simpleTool("recall_memory"), simpleTool("remember")],
  });
  try {
    await startTurn(await Agent.create(runtime), "what do you know?", "memory-thread", options());
    const call = trace.models[0];
    assert.equal(trace.memory, 1);
    assert.deepEqual(call.tools, ["recall_memory"]);
    assert.match(call.prompt, /PRIVATE MEMORY/);
    assert.doesNotMatch(call.prompt, /call remember|call log_conversation/);
  } finally {
    await runtime.close();
  }
});

test("private tools and scoped MCP grants reach only the requested agent graph", async () => {
  const definition = role("developer", {
    useGlobalTools: ["read_file"],
    tools: ["run_tests"],
    useGlobalMcpServers: [{ serverId: "docs", tools: ["fetch"] }],
    mcp: [{ serverId: "github", tools: ["get_issue"] }],
  });
  const { runtime, trace } = await fixture({
    definitions: [role("orchestrator"), definition],
    globalTools: [simpleTool("read_file"), simpleTool("write_file")],
    agentTools: { developer: [simpleTool("run_tests")] },
    mcpTools: [
      simpleTool("mcp__global__docs__fetch"),
      simpleTool("mcp__agent__developer__github__get_issue"),
    ],
  });
  try {
    await startTurn(
      await Agent.create(runtime, "developer"),
      "inspect",
      "developer-thread",
      options(),
    );
    assert.deepEqual(
      trace.mcp[0].access.useGlobalMcpServers,
      definition.capabilities.useGlobalMcpServers,
    );
    assert.deepEqual(trace.mcp[0].access.mcp, definition.capabilities.mcp);
    assert.deepEqual(trace.models[0].tools, [
      "read_file",
      "run_tests",
      "mcp__global__docs__fetch",
      "mcp__agent__developer__github__get_issue",
    ]);
    assert.doesNotMatch(trace.models[0].prompt, /# Memory/);
  } finally {
    await runtime.close();
  }
});

test("skill prompt and tool loader are restricted to permitted metadata", async () => {
  const skills = [
    { name: "review", description: "Allowed description", path: "/allowed/SKILL.md" },
    { name: "hidden", description: "HIDDEN DESCRIPTION", path: "/hidden/SKILL.md" },
  ];
  const { runtime, trace } = await fixture({
    definitions: [role("orchestrator", { useGlobalTools: ["load_skill"], skills: ["review"] })],
    globalTools: [
      tool(
        async () => {
          throw new Error("Unscoped loader was used");
        },
        {
          name: "load_skill",
          description: "Unscoped fixture",
          schema: z.object({ name: z.string() }),
        },
      ),
    ],
    skills,
    respond(messages) {
      const results = messages.filter(ToolMessage.isInstance);
      return results.length
        ? new AIMessage(results.map((message) => message.text).join("\n"))
        : new AIMessage({
            content: "",
            tool_calls: [
              { id: "allowed", name: "load_skill", args: { name: "review" }, type: "tool_call" },
              { id: "forbidden", name: "load_skill", args: { name: "hidden" }, type: "tool_call" },
            ],
          });
    },
  });
  try {
    skills[0].path = "/changed/SKILL.md";
    const result = await startTurn(
      await Agent.create(runtime),
      "load skills",
      "skills-thread",
      options(),
    );
    assert.match(result.text, /instructions: review/);
    assert.match(result.text, /not available. Allowed skills: review/);
    assert.deepEqual(trace.skills, ["review"]);
    for (const call of trace.models) {
      assert.match(call.prompt, /Allowed description/);
      assert.doesNotMatch(call.prompt, /HIDDEN DESCRIPTION/);
    }
    await assert.rejects(
      async () => runtime.readSkill({ name: "review", path: "/other/SKILL.md" }),
      /runtime catalogue/,
    );
  } finally {
    await runtime.close();
  }
});

test("empty installed skill catalogue does not expose load_skill", async () => {
  const { runtime, trace } = await fixture({
    definitions: [role("orchestrator", { useGlobalTools: ["load_skill"], skills: "all" })],
    globalTools: [createLoadSkillTool([])],
  });
  try {
    await startTurn(await Agent.create(runtime), "hello", "no-skills-thread", options());
    assert.deepEqual(trace.models[0].tools, []);
    assert.doesNotMatch(trace.models[0].prompt, /# Skills|load_skill/);
  } finally {
    await runtime.close();
  }
});

test("operator graph preserves production shell approval and resume", async () => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('phase2b')")}`;
  const { runtime, trace } = await fixture({
    definitions: [
      createOrchestratorAgentDefinition(),
      analystAgentDefinition,
      operatorAgentDefinition,
      researcherAgentDefinition,
    ],
    globalTools: createLocalTools([]),
    respond(messages) {
      const result = messages.filter(ToolMessage.isInstance).at(-1);
      return result
        ? new AIMessage(result.text)
        : new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "shell",
                name: "exec_bash_command",
                args: { command },
                type: "tool_call",
              },
            ],
          });
    },
  });
  try {
    const agent = await Agent.create(runtime, "operator");
    const paused = await startTurn(agent, "run harmless command", "shell-thread", options());
    assert.equal(paused.kind, "paused");
    const answers = Object.fromEntries(paused.approvals.map((item) => [item.id, true]));
    const completed = await resumeTurn(agent, answers, "shell-thread", options());
    assert.equal(completed.kind, "done");
    assert.match(completed.text, /phase2b/);
    assert.ok(trace.models.every((call) => call.tools.includes("exec_bash_command")));
  } finally {
    await runtime.close();
  }
});

test("memory index does not inject instructions for an unavailable recall tool", async () => {
  const index = await GraphMemory.prototype.getMemoryIndex.call({
    async run() {
      return [{ name: "User", type: "person" }];
    },
  });
  const prompt = buildSystemPrompt({
    definition: role("reader", { memory: "read" }),
    toolNames: [],
    memoryIndex: index,
    skillIndex: "",
  });
  assert.match(prompt, /User/);
  assert.doesNotMatch(prompt, /call recall_memory|call remember/);
});
