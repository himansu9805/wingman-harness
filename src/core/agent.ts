import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { tools as localTools } from "@/tools/tools";
import { renderSkillIndex } from "@/skills/skills";
import { loadMcpTools } from "@/mcp/mcp";
import { GraphMemory } from "@/memory/graph";
import { strongModel, modelRouter } from "./router";
import { buildSystemPrompt } from "./prompt";

/**
 * Builds the agent graph: routes each turn to a model, then loops
 * model → tools until the model answers.
 */
async function buildAgentGraph() {
  const [mcpTools, skillIndex] = await Promise.all([
    loadMcpTools(),
    renderSkillIndex(),
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
    checkpointer: new MemorySaver(),
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
