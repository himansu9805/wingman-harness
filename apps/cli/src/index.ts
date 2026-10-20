import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { formatRoute } from "./route";
import {
  Agent,
  settings,
  startScheduler,
  recordRun,
  shutdown,
  runUntilDone,
  declinePending,
  type Decide,
  type ScheduledEvent,
  type TurnEvent,
} from "@wingman/core";

/** One thread per CLI session; saved threads would otherwise grow forever. */
const THREAD_ID = `cli-${randomUUID()}`;

let turnQueue: Promise<unknown> = Promise.resolve();

/** Runs turns one at a time, in the order they arrive. */
function enqueueTurn<T>(fn: () => Promise<T>): Promise<T> {
  const result = turnQueue.then(fn);
  turnQueue = result.catch(() => {});
  return result;
}

/**
 * Prints an indicator for what the agent is doing.
 *
 * @param event The turn event to display.
 */
function printEvent(event: TurnEvent) {
  switch (event.type) {
    case "route":
      console.log(`  🧭 ${formatRoute(event)}`);
      break;
    case "skill":
      console.log(`  📘 skill used: ${event.name}`);
      break;
    case "memory":
      console.log(`  🧠 memory: ${event.name}(${JSON.stringify(event.args)})`);
      break;
    case "tool_call":
      console.log(
        `  🔧 tool called: ${event.name}(${JSON.stringify(event.args)})`,
      );
      break;
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
        const options = { signal: turnController.signal, onEvent: printEvent };
        await declinePending(agent, event.threadId, options);
        const output = await runUntilDone(
          agent,
          message,
          event.threadId,
          declineAll,
          options,
        );
        console.log(`● ${output}\n`);
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
          const options = { signal, onEvent: printEvent };
          await declinePending(agent, THREAD_ID, options);
          const text = await runUntilDone(
            agent,
            input,
            THREAD_ID,
            askAtTerminal(signal),
            options,
          );
          console.log(`● ${text}\n`);
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
