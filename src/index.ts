import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { settings } from "@/settings";
import { Agent } from "@/core/agent";
import { closeMcpTools } from "@/mcp/mcp";
import { GraphMemory } from "@/memory/graph";
import { MEMORY_TOOL_NAMES } from "@/tools/tools";
import { closeScheduler, startScheduler } from "@/scheduler/scheduler";
import type { ScheduledEvent } from "@/scheduler/interfaces";
import { recordRun } from "./scheduler/results";
import { setConfirmer } from "@/core/confirm";

const THREAD_ID = "cli-session-1";

let shutdownPromise: Promise<void> | null = null;
let turnQueue: Promise<unknown> = Promise.resolve();

/** Runs turns one at a time, in the order they arrive. */
function enqueueTurn<T>(fn: () => Promise<T>): Promise<T> {
  const result = turnQueue.then(fn);
  turnQueue = result.catch(() => {});
  return result;
}

/**
 * Releases MCP connections and the memory graph. Safe to call more than once.
 */
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await closeScheduler();
    await closeMcpTools();
    await GraphMemory.getInstance().closeGraph();
  })();
  return shutdownPromise;
}

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
 * Prompts for the next line of input.
 *
 * @param rl The readline interface to prompt on.
 * @returns The trimmed input, or `null` if the prompt was closed (Ctrl+C / Ctrl+D).
 */
async function readInput(rl: readline.Interface): Promise<string | null> {
  try {
    return (await rl.question("> ")).trim();
  } catch (err) {
    // rl.close() rejects the pending question with an AbortError.
    if ((err as Error).name === "AbortError") {
      console.log();
      return null;
    }
    throw err;
  }
}

/**
 * Streams one agent turn, printing tool calls as they happen and the final reply.
 *
 * @param agent The agent to run.
 * @param input The user's message.
 * @param signal Aborts the turn when triggered.
 */
async function runTurn(
  agent: Agent,
  input: string,
  threadId: string,
  signal: AbortSignal,
) {
  const stream = await agent.app.stream(
    { messages: [new HumanMessage(input)] },
    {
      configurable: { thread_id: threadId },
      streamMode: "updates",
      signal,
    },
  );

  let finalMessage: AIMessage | undefined;

  for await (const update of stream) {
    const agentUpdate = update.agent;
    if (!agentUpdate) {
      continue;
    }
    const message = agentUpdate.messages[agentUpdate.messages.length - 1];
    if (!AIMessage.isInstance(message)) {
      continue;
    }
    if (message.tool_calls && message.tool_calls.length > 0) {
      printToolCallIndicators(message);
    } else {
      finalMessage = message;
    }
  }

  // `.text` flattens Responses API content blocks and plain strings alike.
  const text = finalMessage?.text || "(no response)";
  console.log(`● ${text}\n`);
  return text;
}

/**
 * Runs the interactive command-line chat loop.
 */
async function main() {
  console.log("Type a message, or /exit to quit.");
  console.log(`(model: ${settings.MODEL_NAME})\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const agent = new Agent(
    settings.MODEL_PROVIDER,
    settings.BASE_URL,
    settings.MODEL_NAME,
    settings.API_KEY,
  );

  // In a TTY, readline owns Ctrl+C (raw mode), so process-level SIGINT never
  // fires. Ctrl+C cancels the in-flight turn, or exits when at the prompt.
  let turnController: AbortController | null = null;
  // True while waiting at "> ", so a scheduled turn knows to redraw it.
  let atPrompt = false;

  rl.on("SIGINT", () => {
    if (turnController) {
      turnController.abort();
    } else {
      rl.close();
    }
  });

  // True during scheduled turns: nobody may be at the terminal, and the "> "
  // question is still pending, so tool confirmations are denied outright.
  let unattended = false;

  // Tools ask through the main interface; a second readline on stdin would
  // double-echo keys and pause stdin when it closes, freezing the prompt.
  setConfirmer(async (question) => {
    if (unattended) return false;
    try {
      const answer = await rl.question(question, {
        signal: turnController?.signal, // Ctrl+C cancels the prompt with the turn
      });
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } catch {
      return false; // aborted or closed counts as "no"
    }
  });

  const runScheduledTurn = (event: ScheduledEvent) =>
    enqueueTurn(async () => {
      if (atPrompt) stdout.write("\r\x1b[K"); // clear the "> " line
      console.log(`⏰ scheduled task ${event.jobId}: ${event.prompt}`);
      turnController = new AbortController();
      unattended = true;
      const startedAt = new Date();
      try {
        const output = await runTurn(
          agent,
          event.prompt,
          event.threadId,
          turnController.signal,
        );
        await recordRun({
          ...event,
          status: "success",
          output,
          startedAt,
          finishedAt: new Date(),
        });
      } catch (err) {
        const status = turnController?.signal.aborted
          ? "interrupted"
          : "failed";
        await recordRun({
          ...event,
          status,
          error: (err as Error).message,
          startedAt,
          finishedAt: new Date(),
        }).catch((e) =>
          console.warn(`[scheduler] Could not record run: ${e.message}`),
        );
        throw err;
      } finally {
        turnController = null;
        unattended = false;
        if (atPrompt) rl.prompt(true); // redraw "> " and whatever was typed
      }
    });

  if (settings.SCHEDULER_ENABLED) {
    try {
      await startScheduler(runScheduledTurn);
    } catch (err) {
      console.warn(`[scheduler] Failed to start: ${(err as Error).message}`);
    }
  }

  try {
    while (true) {
      atPrompt = true;
      const input = await readInput(rl);
      atPrompt = false;

      if (input === null || input === "/exit") break;
      if (!input) continue;

      await enqueueTurn(async () => {
        turnController = new AbortController();
        try {
          await runTurn(agent, input, THREAD_ID, turnController.signal);
        } catch (err) {
          if (turnController.signal.aborted) {
            console.log("\n● [interrupted]\n");
          } else {
            console.log(`● [turn failed: ${(err as Error).message}]\n`);
          }
        } finally {
          turnController = null;
        }
      });
    }
  } finally {
    rl.close();
    await shutdown();
  }
}

// Non-TTY fallback: readline's SIGINT handler only applies to terminals.
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

main().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
