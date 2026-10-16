import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command, type Interrupt } from "@langchain/langgraph";
import type { Agent } from "./agent";
import type { CommandApproval } from "../tools/bash";
import { MEMORY_TOOL_NAMES } from "../tools/tools";

/** Something visible that happened during a turn. */
export type TurnEvent =
  | { type: "route"; choice: string; confidence: number }
  | { type: "skill"; name: string }
  | { type: "memory"; name: string; args: unknown }
  | { type: "tool_call"; name: string; args: unknown };

/** Answers one approval request. */
export type Decide = (request: CommandApproval) => Promise<boolean>;

export interface TurnOptions {
  /** Aborts the turn when triggered. */
  signal: AbortSignal;
  /** Called for each route choice and tool call, as they happen. */
  onEvent?: (event: TurnEvent) => void;
}

type TurnInput = { messages: HumanMessage[] } | Command;

export type TurnResult =
  | { kind: "done"; text: string }
  | { kind: "paused"; interrupts: Interrupt<CommandApproval>[] };

/**
 * Reports the tools requested by an AI message.
 *
 * @param message The AI message containing tool calls.
 * @param onEvent Receives one event per tool call.
 */
function emitToolCalls(
  message: AIMessage,
  onEvent: (event: TurnEvent) => void,
) {
  for (const call of message.tool_calls ?? []) {
    if (call.name === "load_skill") {
      const name = (call.args as { name?: string }).name ?? "?";
      onEvent({ type: "skill", name });
    } else if (MEMORY_TOOL_NAMES.has(call.name)) {
      onEvent({ type: "memory", name: call.name, args: call.args });
    } else {
      onEvent({ type: "tool_call", name: call.name, args: call.args });
    }
  }
}

/**
 * Streams one agent turn, reporting tool calls as they happen. Stops early if
 * a tool pauses the run to ask for approval.
 *
 * @param agent The agent to run.
 * @param input The user's message, or a `Command` resuming a paused run.
 * @param threadId The conversation to run in.
 * @param options Abort signal and event callback.
 * @returns The final reply, or the approval requests the run paused on.
 */
export async function runTurn(
  agent: Agent,
  input: TurnInput,
  threadId: string,
  { signal, onEvent = () => {} }: TurnOptions,
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
      onEvent({
        type: "route",
        choice: route.choice,
        confidence: route.confidence,
      });
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
      emitToolCalls(message, onEvent);
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
 * until the model gives a final reply.
 *
 * @param agent The agent to run.
 * @param message The user's message.
 * @param threadId The conversation to run in.
 * @param decide Answers one approval request.
 * @param options Abort signal and event callback.
 * @returns The final reply.
 */
export async function runUntilDone(
  agent: Agent,
  message: string,
  threadId: string,
  decide: Decide,
  options: TurnOptions,
): Promise<string> {
  let next: TurnInput = { messages: [new HumanMessage(message)] };
  while (true) {
    const result = await runTurn(agent, next, threadId, options);
    if (result.kind === "done") return result.text;
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
 * @param options Abort signal and event callback.
 */
export async function declinePending(
  agent: Agent,
  threadId: string,
  options: TurnOptions,
) {
  const state = await agent.app.graph.getState({
    configurable: { thread_id: threadId },
  });
  const pending = state.tasks.flatMap((t) => t.interrupts ?? []);
  if (pending.length === 0) return;
  const answers = Object.fromEntries(pending.map((it) => [it.id!, false]));
  await runTurn(agent, new Command({ resume: answers }), threadId, options);
}
