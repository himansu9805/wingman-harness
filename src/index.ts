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
import { Command, type Interrupt } from "@langchain/langgraph";
import type { CommandApproval } from "@/tools/bash";

const THREAD_ID = "cli-session-1";

type TurnInput = { messages: HumanMessage[] } | Command;
type TurnResult =
  | { kind: "done"; text: string }
  | { kind: "paused"; interrupts: Interrupt<CommandApproval>[] };
type Decide = (request: CommandApproval) => Promise<boolean>;

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
 * Streams one agent turn, printing tool calls as they happen. Stops early if
 * a tool pauses the run to ask for approval.
 *
 * @param agent The agent to run.
 * @param input The user's message, or a `Command` resuming a paused run.
 * @param threadId The conversation to run in.
 * @param signal Aborts the turn when triggered.
 * @returns The final reply, or the approval requests the run paused on.
 */
async function runTurn(
  agent: Agent,
  input: TurnInput,
  threadId: string,
  signal: AbortSignal,
): Promise<TurnResult> {
  const stream = await agent.app.stream(input, {
    configurable: { thread_id: threadId },
    streamMode: "updates",
    signal,
  });

  let finalMessage: AIMessage | undefined;
  const interrupts: Interrupt<CommandApproval>[] = [];

  for await (const update of stream) {
    const pending = (update as Record<string, unknown>).__interrupt__ as
      | Interrupt<CommandApproval>[]
      | undefined;
    if (pending) {
      interrupts.push(...pending);
      continue;
    }

    const route =
      update["TypeSafeModelRouterMiddleware.before_agent"]?.modelRoute;
    if (route) {
      console.log(`  🧭 ${route.choice} (${route.confidence.toFixed(2)})`);
    }

    const modelUpdate = update.model_request;
    if (!modelUpdate) {
      continue;
    }
    const message = modelUpdate.messages[modelUpdate.messages.length - 1];
    if (!AIMessage.isInstance(message)) {
      continue;
    }
    if (message.tool_calls && message.tool_calls.length > 0) {
      printToolCallIndicators(message);
    } else {
      finalMessage = message;
    }
  }

  if (interrupts.length > 0) return { kind: "paused", interrupts };
  // `.text` flattens Responses API content blocks and plain strings alike.
  return { kind: "done", text: finalMessage?.text || "(no response)" };
}

/**
 * Runs a turn, answering each approval request with `decide` and resuming
 * until the model gives a final reply, which it prints.
 *
 * @param agent The agent to run.
 * @param input The user's message.
 * @param threadId The conversation to run in.
 * @param signal Aborts the turn when triggered.
 * @param decide Answers one approval request.
 * @returns The final reply.
 */
async function runUntilDone(
  agent: Agent,
  input: TurnInput,
  threadId: string,
  signal: AbortSignal,
  decide: Decide,
): Promise<string> {
  let next = input;
  while (true) {
    const result = await runTurn(agent, next, threadId, signal);
    if (result.kind === "done") {
      console.log(`● ${result.text}\n`);
      return result.text;
    }
    // Keyed by interrupt id, so parallel tool calls each get their own answer.
    const answers: Record<string, boolean> = {};
    for (const it of result.interrupts) {
      answers[it.id!] = await decide(it.value!);
    }
    next = new Command({ resume: answers });
  }
}

/**
 * Declines any approval left pending by an aborted turn. Otherwise the
 * thread ends in tool calls with no results, which the model API rejects.
 *
 * @param agent The agent to run.
 * @param threadId The conversation to clean up.
 * @param signal Aborts the cleanup when triggered.
 */
async function declinePending(
  agent: Agent,
  threadId: string,
  signal: AbortSignal,
) {
  const state = await agent.app.graph.getState({
    configurable: { thread_id: threadId },
  });
  const pending = state.tasks.flatMap((t) => t.interrupts ?? []);
  if (pending.length === 0) return;
  const answers = Object.fromEntries(pending.map((it) => [it.id!, false]));
  await runTurn(agent, new Command({ resume: answers }), threadId, signal);
}

/**
 * Runs the interactive command-line chat loop.
 */
async function main() {
  console.log("Type a message, or /exit to quit.");
  console.log(
    `(models: fast ${settings.FAST_MODEL_NAME} · strong ${settings.STRONG_MODEL_NAME})\n`,
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const agent = await Agent.create();

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

  // Asks through the main interface; a second readline on stdin would
  // double-echo keys and pause stdin when it closes, freezing the prompt.
  // Ctrl+C rejects the question, which aborts the turn; the next turn then
  // declines whatever was left pending.
  const askAtTerminal =
    (signal: AbortSignal): Decide =>
    async ({ command }) => {
      const answer = await rl.question(
        ` ▶️ Execute command: "${command}"? [y/N]: `,
        { signal },
      );
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    };

  // Scheduled turns: nobody may be at the terminal, and the "> " question is
  // still pending, so approvals are declined outright.
  const declineAll: Decide = async () => false;

  const runScheduledTurn = (event: ScheduledEvent) =>
    enqueueTurn(async () => {
      if (atPrompt) stdout.write("\r\x1b[K"); // clear the "> " line
      console.log(`⏰ scheduled task ${event.jobId}: ${event.prompt}`);
      turnController = new AbortController();
      const startedAt = new Date();
      try {
        // Without this framing, a firing "remind me…" prompt reads like a new
        // request: the model schedules or lists tasks instead of doing it.
        const message =
          `This is a task the user scheduled earlier, and it is due right ` +
          `now:\n\n"${event.prompt}"\n\n` +
          `Carry it out now. Your reply is delivered to the user as the ` +
          `result, so if it's a reminder, your reply IS the reminder: write ` +
          `a short, friendly message to the user, e.g. "Time to drink some ` +
          `water! 💧". Use a tool only if the task needs information or an ` +
          `action you can't do in your reply. Don't schedule, list or cancel ` +
          `tasks. Nobody may be at the keyboard, so commands that need ` +
          `approval will be declined.`;
        await declinePending(agent, event.threadId, turnController.signal);
        const output = await runUntilDone(
          agent,
          { messages: [new HumanMessage(message)] },
          event.threadId,
          turnController.signal,
          declineAll,
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
          const { signal } = turnController;
          await declinePending(agent, THREAD_ID, signal);
          await runUntilDone(
            agent,
            { messages: [new HumanMessage(input)] },
            THREAD_ID,
            signal,
            askAtTerminal(signal),
          );
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
