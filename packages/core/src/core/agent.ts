import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { tools as localTools } from "../tools/tools";
import { strongModel, modelRouter } from "./router";
import { buildSystemPrompt } from "./prompt";
import type { CoreRuntime } from "./runtime";

/** Builds the model/tool loop using borrowed runtime services. */
function buildAgentGraph(runtime: CoreRuntime) {
  runtime.assertOpen();

  const { mcpTools, skillIndex, checkpointer } = runtime;

  return createAgent({
    // The router selects the model for each turn.
    model: strongModel,
    tools: [...localTools, ...mcpTools],
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
  private constructor(readonly app: ReturnType<typeof buildAgentGraph>) {}

  /**
   * Creates a graph without acquiring additional infrastructure connections.
   *
   * @param runtime The initialized application runtime.
   * @throws If runtime shutdown has already started.
   */
  static async create(runtime: CoreRuntime): Promise<Agent> {
    return new Agent(buildAgentGraph(runtime));
  }
}
