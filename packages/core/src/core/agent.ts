import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { tools as localTools } from "../tools/tools";
import { strongModel, modelRouter } from "./router";
import { buildSystemPrompt } from "./prompt";
import type { CoreRuntime } from "./runtime";
import { createDefaultAgentDefinition } from "./agents/defaults";
import { AgentToolCatalogue } from "./agents/catalogue";
import { settings } from "../settings";

/** Builds the model/tool loop using borrowed runtime services. */
async function buildAgentGraph(runtime: CoreRuntime) {
  runtime.assertOpen();

  const { mcp, skillIndex, checkpointer } = runtime;
  const definition = createDefaultAgentDefinition(settings.SCHEDULER_ENABLED);
  const selectedTools = new AgentToolCatalogue(localTools).resolve(
    definition.id,
    definition.capabilities.useGlobalTools,
    definition.capabilities.tools,
  );
  const mcpTools = await mcp.getTools(definition.id, definition.capabilities);
  runtime.assertOpen();
  const names = new Set<string>(selectedTools.map((tool) => tool.name));
  for (const tool of mcpTools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate agent tool name "${tool.name}"`);
    }
    names.add(tool.name);
  }

  return createAgent({
    // The router selects the model for each turn.
    model: strongModel,
    tools: [...selectedTools, ...mcpTools],
    middleware: [
      modelRouter,
      dynamicSystemPromptMiddleware(async () =>
        buildSystemPrompt(await runtime.getMemoryIndex(), skillIndex),
      ),
    ],
    checkpointer,
  });
}

/** An agent graph whose shared infrastructure is owned by its runtime. */
export class Agent {
  private constructor(
    readonly app: Awaited<ReturnType<typeof buildAgentGraph>>,
  ) {}

  /**
   * Creates a graph using runtime-owned services. Granted MCP profiles connect
   * lazily on first use and are reused by later graphs sharing this runtime.
   *
   * @param runtime The initialized application runtime.
   * @throws If runtime shutdown has already started.
   */
  static async create(runtime: CoreRuntime): Promise<Agent> {
    return new Agent(await buildAgentGraph(runtime));
  }
}
