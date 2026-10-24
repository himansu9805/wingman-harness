import type { Message, ThreadEvent, ToolCall } from "../api/types";

export interface TranscriptTurn {
  id: string;
  user?: Message;
  messages: Message[];
  events: ThreadEvent[];
}

/** Keep a user prompt and the complete assistant/tool loop in one visual turn. */
export function transcript(
  messages: Message[],
  events: ThreadEvent[],
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of messages) {
    if (message.role === "user")
      turns.push({ id: message.id, user: message, messages: [], events: [] });
    else {
      if (!turns.length)
        turns.push({ id: message.id, messages: [], events: [] });
      turns.at(-1)!.messages.push(message);
    }
  }
  if (!turns.length && events.length)
    turns.push({ id: "live", messages: [], events: [] });
  const runs = new Map<string, ThreadEvent[]>();
  for (const event of events) {
    const run = runs.get(event.runId) ?? [];
    run.push(event);
    runs.set(event.runId, run);
  }
  const entries = [...runs];
  const assignment = new Map<string, number>();
  // Match final replies backwards so repeated short replies stay on the right turn.
  let before = turns.length;
  for (const [runId, run] of entries.toReversed()) {
    const done = run.findLast((event) => event.type === "done");
    if (done?.type !== "done") continue;
    for (let i = before - 1; i >= 0; i--) {
      if (turns[i].messages.some((message) => message.text === done.text)) {
        assignment.set(runId, i);
        before = i;
        break;
      }
    }
  }
  // Approval/resume metadata carries an explicit turn ID. Prefer that relationship
  // over inferring the link from tool names or repeated response text.
  const turnIds = new Map(entries.flatMap(([runId, events]) => {
    const snapshot = events.findLast(event => event.type === 'run');
    return snapshot?.type === 'run' ? [[runId, snapshot.metadata.turnId] as const] : [];
  }));
  for (const [runId, turnId] of turnIds) {
    const known = [...turnIds].find(([id, related]) => related === turnId && assignment.has(id));
    if (known) assignment.set(runId, assignment.get(known[0])!);
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const [runId, run] = entries[index];
    if (assignment.has(runId)) continue;
    const ids = new Set(
      run.flatMap((event) =>
        "toolCallId" in event && event.toolCallId ? [event.toolCallId] : [],
      ),
    );
    // A resumed run belongs to the same user prompt as the paused tool invocation.
    const next = entries[index + 1];
    const resumed =
      next &&
      run.some((event) => event.type === "approval") &&
      next[1].some(
        (event) => event.type === "tool_result" && ids.has(event.toolCallId),
      );
    let match = resumed ? (assignment.get(next[0]) ?? -1) : -1;
    if (match < 0)
      match = turns.findLastIndex((turn) =>
        turn.messages.some((message) =>
          message.toolCalls?.some((call) => ids.has(call.id)),
        ),
      );
    if (match < 0) match = turns.length - 1;
    if (match >= 0) assignment.set(runId, match);
  }
  for (const event of events) {
    const index = assignment.get(event.runId);
    if (index !== undefined) turns[index].events.push(event);
  }
  return turns;
}

/** Memory and skills are tool activity, not separate system announcements. */
export function liveCalls(turn: TranscriptTurn): ToolCall[] {
  const saved = new Set(
    turn.messages.flatMap(
      (message) => message.toolCalls?.map((call) => call.id) ?? [],
    ),
  );
  const calls = new Map<string, ToolCall>();
  turn.events.forEach((event, index) => {
    if (
      !["tool_call", "memory", "skill"].includes(event.type) ||
      !("name" in event)
    )
      return;
    const id =
      "toolCallId" in event && event.toolCallId
        ? event.toolCallId
        : `live-${event.runId}-${index}`;
    if (saved.has(id)) return;
    calls.set(id, {
      id,
      name: event.type === "skill" ? "load_skill" : event.name,
      args:
        event.type === "skill"
          ? { name: event.name }
          : "args" in event
            ? event.args
            : {},
    });
  });
  return [...calls.values()];
}

export function toolLabel(call: ToolCall): { name: string; target: string } {
  const labels: Record<string, string> = {
    exec_bash_command: "Run command",
    recall_memory: "Recall memory",
    remember_memory: "Remember",
    store_memory: "Remember",
    load_skill: "Load skill",
  };
  const args = call.args ?? {};
  const target = [args.command, args.name, args.query].find(
    (value) => typeof value === "string",
  );
  return {
    name: labels[call.name] ?? call.name.replaceAll("_", " "),
    target: typeof target === "string" ? target : JSON.stringify(args),
  };
}
