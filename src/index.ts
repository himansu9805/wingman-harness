import { settings } from "@/settings";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { Agent } from "@/core/agent";
import { closeMcpTools } from "@/mcp/mcp";
import { MEMORY_TOOL_NAMES } from "@/tools/tools";
import { GraphMemory } from "@/memory/graph";

const THREAD_ID = "cli-session-1";

/**
 * Prints indicators for the tools requested by an AI message.
 *
 * @param message The AI message containing tool calls to display.
 */
function printToolCallIndicators(message: AIMessage) {
  for (const call of message.tool_calls ?? []) {
    if (call.name === "load_skill") {
      const skillName = (call.args as { name?: string }).name ?? "?";
      console.log(`  📘 skill used: ${skillName}`);
    } else if (MEMORY_TOOL_NAMES.has(call.name)) {
      console.log(`  🧠 memory: ${call.name}(${JSON.stringify(call.args)})`);
    } else {
      console.log(
        `  🔧 tool called: ${call.name}(${JSON.stringify(call.args)})`,
      );
    }
  }
}

/**
 * Runs the interactive command-line chat loop.
 */
async function main() {
  console.log("Type a message, or /exit to quit.");
  console.log(`(model: ${settings.MODEL_NAME} via Ollama)\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const agent = new Agent(settings.BASE_URL, settings.MODEL_NAME);

  try {
    while (true) {
      const input = (await rl.question("> ")).trim();

      if (input === "/exit") {
        break;
      }

      if (!input) {
        continue;
      }

      const stream = await agent.app.stream(
        { messages: [new HumanMessage(input)] },
        { configurable: { thread_id: THREAD_ID }, streamMode: "updates" },
      );

      let finalMessage: AIMessage | undefined;

      for await (const update of stream) {
        const agentUpdate = update.agent;
        if (agentUpdate) {
          const message = agentUpdate.messages[agentUpdate.messages.length - 1];
          if (AIMessage.isInstance(message)) {
            if (message.tool_calls && message.tool_calls.length > 0) {
              printToolCallIndicators(message);
            } else {
              finalMessage = message;
            }
          }
        }
      }
      console.log(`● ${finalMessage?.content ?? "(no response)"}\n`);
    }
  } catch (err) {
    console.log(`● [turn failed: ${(err as Error).message}]\n`);
  } finally {
    rl.close();
    await closeMcpTools();
    await GraphMemory.getInstance().closeGraph();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeMcpTools();
  await GraphMemory.getInstance().closeGraph();
  process.exit(1);
});

process.on("SIGINT", async () => {
  await closeMcpTools();
  await GraphMemory.getInstance().closeGraph();
  process.exit(0);
});
