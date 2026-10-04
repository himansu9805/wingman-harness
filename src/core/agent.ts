import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
  MemorySaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tools as localTools } from "@/tools/tools";
import { renderSkillIndex } from "@/skills/skills";
import { loadMcpTools } from "@/mcp/mcp";
import { GraphMemory } from "@/memory/graph";

export class Agent {
  private readonly modelProvider: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly apiKey: string;
  private readonly checkpointer = new MemorySaver();
  private readonly toolsPromise: Promise<StructuredToolInterface[]>;
  private readonly boundModelPromise: Promise<
    ReturnType<ChatOpenAI["bindTools"]>
  >;
  private toolNodePromise: Promise<ToolNode> | null = null;
  private readonly skillIndexPromise: Promise<string>;

  readonly app;

  constructor(
    modelProvider: string,
    baseUrl: string,
    modelName: string,
    apiKey: string,
  ) {
    this.modelProvider = modelProvider;
    this.baseUrl = baseUrl;
    this.modelName = modelName;
    this.apiKey = apiKey;

    this.toolsPromise = loadMcpTools().then((mcpTools) => [
      ...localTools,
      ...mcpTools,
    ]);

    this.boundModelPromise = this.toolsPromise.then((allTools) =>
      new ChatOpenAI({
        model: this.modelName,
        apiKey: this.apiKey,
        // Ollama's OpenAI-compatible endpoint targets Chat Completions, so
        // only use the Responses API against OpenAI itself.
        useResponsesApi: this.modelProvider === "OPENAI",
        // reasoning: { effort: "none" },
        ...(this.modelProvider !== "OPENAI"
          ? {
              configuration: {
                baseURL: this.baseUrl,
              },
            }
          : {}),
      }).bindTools(allTools),
    );

    this.skillIndexPromise = renderSkillIndex();

    this.app = new StateGraph(MessagesAnnotation)
      .addNode("agent", this.callModel.bind(this))
      .addNode("tools", this.toolsNode.bind(this))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", this.shouldContinue.bind(this), {
        tools: "tools",
        [END]: END,
      })
      .addEdge("tools", "agent")
      .compile({ checkpointer: this.checkpointer });
  }

  private async getToolNode(): Promise<ToolNode> {
    if (!this.toolNodePromise) {
      this.toolNodePromise = this.toolsPromise.then(
        (allTools) => new ToolNode(allTools),
      );
    }
    return this.toolNodePromise;
  }

  private async toolsNode(state: typeof MessagesAnnotation.State) {
    const toolNode = await this.getToolNode();
    return toolNode.invoke(state);
  }

  private async buildSystemMessage(): Promise<SystemMessage> {
    const [skillIndex, memoryIndex] = await Promise.all([
      this.skillIndexPromise,
      GraphMemory.getInstance().getMemoryIndex(),
    ]);

    const sections: string[] = [];
    if (memoryIndex) {
      sections.push(memoryIndex);
    }
    sections.push(skillIndex || "You have no skills available.");

    return new SystemMessage(sections.join("\n\n"));
  }

  private async callModel(state: typeof MessagesAnnotation.State) {
    const [systemMessage, model] = await Promise.all([
      this.buildSystemMessage(),
      this.boundModelPromise,
    ]);
    const response = await model.invoke([systemMessage, ...state.messages]);
    return { messages: [response] };
  }

  private shouldContinue(state: typeof MessagesAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    return lastMessage.tool_calls?.length ? "tools" : END;
  }
}
