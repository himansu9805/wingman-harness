import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { tools as localTools } from "../tools/tools";
import { renderSkillIndex } from "../skills/skills";
import { loadMcpTools } from "../mcp/mcp";
import { GraphMemory } from "../memory/graph";
import { strongModel, modelRouter } from "./router";
import { buildSystemPrompt } from "./prompt";
import { createCheckpointer } from "./checkpointer";

/**
 * Builds the agent graph: routes each turn to a model, then loops
 * model → tools until the model answers.
 */
async function buildAgentGraph() {
  const [mcpTools, skillIndex, checkpointer] = await Promise.all([
    loadMcpTools(),
    renderSkillIndex(),
    createCheckpointer(),
  ]);

  return createAgent({
    // The router overrides this on every call; it's the declared default.
    model: strongModel,
    tools: [...localTools, ...mcpTools],
    middleware: [
      modelRouter,
      // Rebuilt before every model call, so new memories show up mid-session.
      dynamicSystemPromptMiddleware(async () =>
        buildSystemPrompt(
          await GraphMemory.getInstance().getMemoryIndex(),
          skillIndex,
        ),
      ),
    ],
    checkpointer,
  });
}

export class Agent {
  private constructor(
    readonly app: Awaited<ReturnType<typeof buildAgentGraph>>,
  ) {}

  /** Creates the agent once MCP tools and skills have loaded. */
  static async create(): Promise<Agent> {
    return new Agent(await buildAgentGraph());
  }
}
