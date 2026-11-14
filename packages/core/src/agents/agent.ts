import type { TurnEventHandler } from "../conversations/turn";
import { createAgent, dynamicSystemPromptMiddleware, type AnyAgentMiddleware } from "langchain";
import { buildSystemPrompt } from "./prompt";
import type { CoreRuntime } from "../runtime/runtime";
import type { RegisteredAgentDefinition } from "./registry";
import { createLoadSkillTool } from "../capabilities/catalogue";
import { renderSkillIndex } from "../skills/catalogue";
import type { StructuredToolInterface } from "@langchain/core/tools";

/** Resolves a registered role without acquiring a second set of runtime services. */
async function buildAgentGraph(
  runtime: CoreRuntime,
  definition: RegisteredAgentDefinition,
  execution: readonly AnyAgentMiddleware[] = [],
) {
  runtime.assertOpen();
  await runtime.prepareAgent(definition.id);
  const capabilities = definition.capabilities;
  const selection = capabilities.skills;
  const skills =
    selection === "all"
      ? runtime.skills
      : runtime.skills.filter((skill) => selection.includes(skill.name));
  const localTools = runtime.toolCatalogue
    .resolve(definition.id, capabilities.useGlobalTools, capabilities.tools)
    .flatMap<StructuredToolInterface>((tool) =>
      tool.name === "load_skill"
        ? skills.length
          ? [createLoadSkillTool(skills, runtime.readSkill)]
          : []
        : [tool],
    );
  const mcpTools = await runtime.mcp.getTools(definition.id, capabilities);
  runtime.assertOpen();
  const tools = [...localTools, ...mcpTools];
  const toolNames = tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error(`Duplicate tools for agent "${definition.id}"`);
  }
  for (const name of Object.keys(definition.execution?.toolCallLimits ?? {})) {
    if (!toolNames.includes(name))
      throw new Error(`Tool-call limit references unavailable tool "${name}"`);
  }
  const skillIndex = renderSkillIndex(skills);
  const model = definition.model === "fast" ? runtime.models.fast : runtime.models.powerful;

  const parameters = {
    model,
    tools,
    checkpointer: runtime.checkpointer,
  };
  const prompt = dynamicSystemPromptMiddleware(async () =>
    buildSystemPrompt({
      definition,
      toolNames,
      memoryIndex: capabilities.memory === "none" ? "" : await runtime.getMemoryIndex(),
      skillIndex,
    }),
  );
  if (definition.model === "routed") {
    return createAgent({
      ...parameters,
      middleware: [runtime.models.routingMiddleware, prompt, ...execution] as const,
    });
  }
  return createAgent({ ...parameters, middleware: [prompt, ...execution] as const });
}

/** A role-specific graph borrowing services owned by its application runtime. */
export class Agent {
  private constructor(
    readonly id: string,
    readonly app: Awaited<ReturnType<typeof buildAgentGraph>>,
    private readonly runtime: CoreRuntime,
  ) {}

  /** Trusted target used to validate pending command approvals on resume. */

  /** Read-only sandbox metadata and output, when sandbox execution is enabled. */
  get sandboxMonitor() {
    return this.runtime.sandboxMonitor;
  }

  /** Cleans internal child checkpoints without creating or deleting sidebar chats. */
  deleteDelegatedState(conversationId: string): Promise<void> {
    return this.runtime.plans.deleteConversation(conversationId);
  }

  /** Releases resources owned by the conversation after its workers are stopped. */
  releaseConversation(conversationId: string): Promise<void> {
    return this.runtime.releaseExecution(conversationId);
  }

  /** Cancels unfinished workers before abandoning a parent turn. */
  cancelDelegations(conversationId: string, onEvent?: TurnEventHandler): Promise<void> {
    return this.runtime.plans.cancelConversation(conversationId, onEvent);
  }

  /**
   * Builds a validated agent graph. Unknown IDs fail before MCP discovery.
   * Independent executions must use distinct checkpoint thread IDs; delegated
   * execution namespaces are supplied by the orchestration layer.
   *
   * @param runtime The application-owned services and validated role registry.
   * @param agentId Registered role ID; existing entry points use "orchestrator".
   * @param execution Trusted worker middleware for durable budgets and tool outcomes.
   * @throws If the role is unknown, discovery fails, or shutdown has started.
   */
  static async create(
    runtime: CoreRuntime,
    agentId = "orchestrator",
    execution: readonly AnyAgentMiddleware[] = [],
  ): Promise<Agent> {
    runtime.assertOpen();
    const definition = runtime.agents.get(agentId);
    return new Agent(definition.id, await buildAgentGraph(runtime, definition, execution), runtime);
  }
}
