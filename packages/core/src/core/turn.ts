import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command, type Interrupt } from "@langchain/langgraph";
import type { Agent } from "./agent";
import type { CommandApproval } from "../tools/bash";
import { MEMORY_TOOL_NAMES } from "../tools/names";

/** Something visible that happened during a turn. */
export type TurnEvent =
  | {
      type: "route";
      choice: string;
      confidence: number;
      /** Raw classifier probabilities; optional for older route state. */
      probabilities?: Record<string, number>;
    }
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

/** A command waiting for the user's approval. */
export interface PendingApproval {
  id: string;
  command: string;
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
        ...(route.probabilities ? { probabilities: route.probabilities } : {}),
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
  let result = await startTurn(agent, message, threadId, options);
  while (result.kind === "paused") {
    // Keyed by interrupt id, so parallel tool calls each get their own answer.
    const answers: Record<string, boolean> = {};
    for (const it of result.interrupts) {
      answers[it.id!] = await decide(it.value!);
    }
    result = await resumeTurn(agent, answers, threadId, options);
  }
  return result.text;
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
  const pending = await getPendingApprovals(agent, threadId);
  if (pending.length === 0) return;
  const answers = Object.fromEntries(pending.map((p) => [p.id, false]));
  let result = await resumeTurn(agent, answers, threadId, options);
  let remainingRounds = 24;
  while (result.kind === "paused") {
    options.signal.throwIfAborted();
    if (remainingRounds-- === 0) {
      throw new Error("Approval cleanup exceeded 25 rounds; thread remains paused");
    }
    const declines = Object.fromEntries(
      result.interrupts.map((it) => [it.id!, false]),
    );
    result = await resumeTurn(agent, declines, threadId, options);
  }
}

/** Starts a turn from a user message; returns when it finishes or pauses. */
export function startTurn(
  agent: Agent,
  message: string,
  threadId: string,
  options: TurnOptions,
): Promise<TurnResult> {
  return runTurn(
    agent,
    { messages: [new HumanMessage(message)] },
    threadId,
    options,
  );
}

/**
 * Resumes a paused turn with an answer for each pending approval.
 *
 * @param answers Approved or not, keyed by interrupt id.
 */
export function resumeTurn(
  agent: Agent,
  answers: Record<string, boolean>,
  threadId: string,
  options: TurnOptions,
): Promise<TurnResult> {
  return runTurn(agent, new Command({ resume: answers }), threadId, options);
}

/** Lists the commands a thread is paused on, if any. */
export async function getPendingApprovals(
  agent: Agent,
  threadId: string,
): Promise<PendingApproval[]> {
  const state = await agent.app.graph.getState({
    configurable: { thread_id: threadId },
  });
  return state.tasks
    .flatMap((t) => (t.interrupts ?? []) as Interrupt<CommandApproval>[])
    .map((it) => ({ id: it.id!, command: it.value!.command }));
}
