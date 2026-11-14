import type { ThreadEvent, ToolCall } from "../../../shared/contracts/types";

export type RunPhase = "idle" | "running" | "paused" | "done" | "error";
export interface Activity {
  phase: RunPhase;
  runId?: string;
  events: ThreadEvent[];
}
export const emptyActivity: Activity = { phase: "idle", events: [] };

/** Identify event records whose newer snapshots supersede earlier revisions. */
function snapshotKey(event: ThreadEvent): string | undefined {
  if (event.type === "run") return `run:${event.runId}`;
  if (event.type === "delegation_plan") return `plan:${event.planId}`;
  return undefined;
}

/** Update live activity from an event, replacing snapshots and excluding title-only notifications. */
export function applyEvent(state: Activity, event: ThreadEvent): Activity {
  if (event.type === "thread_title") return state;
  const phase: RunPhase =
    event.type === "run"
      ? (
          {
            running: "running",
            paused: "paused",
            completed: "done",
            failed: "error",
            interrupted: "error",
          } as const
        )[event.metadata.status]
      : event.type === "approval"
        ? "paused"
        : event.type === "done"
          ? "done"
          : event.type === "error"
            ? "error"
            : "running";
  // A snapshot replaces the previous version; usage values are already cumulative.
  const key = snapshotKey(event);
  const previous = key ? state.events.filter((item) => snapshotKey(item) !== key) : state.events;
  return { runId: event.runId, phase, events: [...previous, event] };
}

/** Tool IDs, rather than names or run IDs, connect results across approval resumes. */
export function toolsWithResults(calls: ToolCall[], events: ThreadEvent[]): ToolCall[] {
  return calls.map((call) => {
    const request = events.findLast(
      (event) => event.type === "tool_call" && event.toolCallId === call.id,
    );
    const withTarget =
      request?.type === "tool_call" && request.target ? { ...call, target: request.target } : call;
    if (call.result) return withTarget;
    const calledAt = events.findLastIndex(
      (event) =>
        "toolCallId" in event && event.toolCallId === call.id && event.type !== "tool_result",
    );
    const result = events.findLast(
      (event, index) =>
        index > calledAt && event.type === "tool_result" && event.toolCallId === call.id,
    );
    return result?.type === "tool_result"
      ? { ...withTarget, result: { output: result.output, truncated: result.truncated } }
      : withTarget;
  });
}

/** Merge an older page without replacing newer live snapshots or changing the current run. */
export function prependActivity(state: Activity, older: ThreadEvent[]): Activity {
  const bySequence = new Map([...older, ...state.events].map((event) => [event.sequence, event]));
  const chronological = [...bySequence.values()].sort((left, right) => {
    const a = BigInt(left.sequence!);
    const b = BigInt(right.sequence!);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const seen = new Set<string>();
  const events = chronological
    .reverse()
    .filter((event) => {
      if (event.type === "thread_title") return false;
      const key = snapshotKey(event);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
  return { ...state, events };
}
