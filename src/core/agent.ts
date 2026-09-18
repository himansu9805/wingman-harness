import { ChatOllama } from "@langchain/ollama";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
  MemorySaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tools } from "@/tools/tools";
import { renderSkillIndex } from "@/skills/skills";

export class Agent {
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly toolNode = new ToolNode(tools);
  private readonly checkpointer = new MemorySaver();

  private readonly systemMessagePromise: Promise<SystemMessage>;

  private readonly model;
  readonly app;

  constructor(baseUrl: string, modelName: string) {
    this.baseUrl = baseUrl;
    this.modelName = modelName;
    this.systemMessagePromise = renderSkillIndex().then(
      (index) => new SystemMessage(index || "You have no skills available."),
    );
    this.model = new ChatOllama({
      model: this.modelName,
      baseUrl: this.baseUrl,
      temperature: 0.7,
    }).bindTools(tools);
    this.app = new StateGraph(MessagesAnnotation)
      .addNode("agent", this.callModel.bind(this))
      .addNode("tools", this.toolNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", this.shouldContinue.bind(this), {
        tools: "tools",
        [END]: END,
      })
      .addEdge("tools", "agent")
      .compile({ checkpointer: this.checkpointer });
  }

  private async callModel(state: typeof MessagesAnnotation.State) {
    const systemMessage = await this.systemMessagePromise;
    const response = await this.model.invoke([
      systemMessage,
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  private shouldContinue(state: typeof MessagesAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

    return lastMessage.tool_calls?.length ? "tools" : END;
  }
}
