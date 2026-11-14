import { sandboxExecutor } from "./sandbox-executor.mjs";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import "../setup.mjs";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { CoreRuntime } from "../../packages/core/src/runtime/runtime.ts";
import { assembleAgentModules } from "../../packages/core/src/agents/module.ts";
import { Agent } from "../../packages/core/src/agents/agent.ts";
import {
  coderAgentDefinition,
  builtinAgentModules,
} from "../../packages/core/src/agents/builtins/index.ts";
import { createLocalTools } from "../../packages/core/src/capabilities/catalogue.ts";
import { MemoryDelegationStore } from "../../packages/core/src/delegation/storage/store.ts";

class DelegationModel extends BaseChatModel {
  constructor(
    trace,
    child,
    args,
    boundTools = [],
    summarize = (result) => `Orchestrator: ${result.text}`,
  ) {
    super({});
    Object.assign(this, { trace, child, args, boundTools, summarize });
  }
  _llmType() {
    return "durable-delegation-test";
  }
  bindTools(tools) {
    return new DelegationModel(this.trace, this.child, this.args, tools, this.summarize);
  }
  async _generate(messages, options) {
    const prompt = messages
      .filter(SystemMessage.isInstance)
      .map((message) => message.text)
      .join("\n");
    const child = !prompt.includes("# Agent: orchestrator");
    this.trace.calls.push({
      child,
      messages,
      prompt,
      tools: this.boundTools.map((tool) => tool.name),
    });
    let response;
    if (child) response = await this.child(messages, options);
    else {
      const lastUser = messages.findLastIndex(HumanMessage.isInstance);
      const result = messages.slice(lastUser + 1).find(ToolMessage.isInstance);
      response = result
        ? this.summarize(result)
        : messages[lastUser].text.startsWith("simple")
          ? "Direct response"
          : [
              {
                id: "delegate-call",
                name: "delegate_task",
                args: this.args,
                type: "tool_call",
              },
            ];
    }
    const message = new AIMessage({
      content: Array.isArray(response) ? "" : response,
      tool_calls: Array.isArray(response) ? response : [],
      usage_metadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    return { generations: [{ text: message.text, message }] };
  }
}

export async function createDelegationRuntime({
  store = new MemoryDelegationStore(),
  saver = new MemorySaver(),
  plan,
  delegationConcurrency = 4,
  maxConcurrency = 2,
  maxTasks = 8,
  coderTools = [],
  commandExecutor = sandboxExecutor,
  researchTools = [],
  researchExecution,
  executionResources = [],
  summarize,
  child = async () => "Specialist analysis",
  timeoutMs = 30000,
  maxModelCalls = 8,
  args = {
    agentId: "analyst",
    objective: "Compare supplied options",
    context: "Only this scoped context",
  },
} = {}) {
  const trace = { calls: [], memory: 0 };
  const model = new DelegationModel(
    trace,
    child,
    plan ?? { tasks: [{ key: "task", ...args, expectedResult: "Concise answer", dependsOn: [] }] },
    [],
    summarize,
  );
  const { definitions } = assembleAgentModules(builtinAgentModules(false));
  if (researchExecution) {
    const researcher = definitions.find((definition) => definition.id === "researcher");
    researcher.execution = { ...researcher.execution, ...researchExecution };
  }
  const researcher = definitions.find((definition) => definition.id === "researcher");
  const availableResearchTools = researcher.capabilities.useGlobalMcpServers.flatMap((grant) =>
    grant.tools.map((name) => {
      const exposed = `mcp__global__${grant.serverId}__${name}`;
      return (
        researchTools.find((tool) => tool.name === exposed) ??
        tool(
          async () => {
            throw new Error(`Unexpected fixture tool invocation: ${exposed}`);
          },
          { name: exposed, description: exposed, schema: z.record(z.string(), z.unknown()) },
        )
      );
    }),
  );
  const definition = definitions.find((definition) => definition.id === "orchestrator");
  definition.delegation.timeoutMs = timeoutMs;
  definition.delegation.maxModelCalls = maxModelCalls;
  definition.delegation.maxConcurrency = maxConcurrency;
  definition.delegation.maxTasks = maxTasks;
  const runtime = await CoreRuntime.create({
    async openMcp() {
      return {
        serverIds: ["openserp"],
        privateServerIds() {
          return [];
        },
        async getTools(_id, access) {
          return access.useGlobalMcpServers.some((grant) => grant.serverId === "openserp")
            ? availableResearchTools
            : [];
        },
        async close() {},
      };
    },
    async loadSkills() {
      return [];
    },
    async loadConfiguration() {
      return {
        delegationConcurrency,
        executionResources,
        definitions: [
          definition,
          ...definitions.filter((definition) => !["orchestrator", "coder"].includes(definition.id)),
          coderTools.length
            ? {
                ...coderAgentDefinition,
                capabilities: {
                  ...coderAgentDefinition.capabilities,
                  useGlobalTools: coderTools.map((tool) => tool.name),
                },
              }
            : coderAgentDefinition,
        ],
        globalTools: [...createLocalTools([], commandExecutor), ...coderTools],
        models: {
          fast: model,
          powerful: model,
          routingMiddleware: createMiddleware({
            name: "TestRouter",
            wrapModelCall: (request, handler) => handler(request),
          }),
        },
      };
    },
    async openCheckpointer() {
      return { saver, async close() {} };
    },
    async openDelegations() {
      return store;
    },
    async readSkill() {
      throw new Error("No skills granted");
    },
    async getMemoryIndex() {
      trace.memory++;
      return "ROOT PRIVATE MEMORY";
    },
    async stopScheduler() {},
    async closeResults() {},
    async closeMemory() {},
  });
  return { runtime, agent: await Agent.create(runtime), trace, store, saver };
}
