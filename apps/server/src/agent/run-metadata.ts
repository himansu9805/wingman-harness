import { addUsage, emptyUsage, type TokenUsage } from "@wingman/core/turns";
export { addUsage, emptyUsage, type TokenUsage } from "@wingman/core/turns";

export type RunStatus = "running" | "paused" | "completed" | "failed" | "interrupted";
export interface RunMetadata {
  runId: string;
  turnId: string;
  parentRunId: string | null;
  origin: "message" | "resume" | "scheduled";
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  processingMs: number;
  approvalWaitMs: number;
  usage: TokenUsage;
  turn: {
    startedAt: string;
    completedAt: string | null;
    elapsedMs: number;
    processingMs: number;
    approvalWaitMs: number;
    usage: TokenUsage;
  };
}
/** The event journal is authoritative; resume correlation survives process restarts. */
export function startMetadata(
  runId: string,
  origin: RunMetadata["origin"],
  now: Date,
  previous?: RunMetadata,
): RunMetadata {
  const parent = origin === "resume" && previous?.status === "paused" ? previous : undefined;
  const startedAt = now.toISOString();
  const approvalWaitMs = parent?.finishedAt
    ? Math.max(0, now.getTime() - Date.parse(parent.finishedAt))
    : 0;
  return {
    runId,
    turnId: parent?.turnId ?? runId,
    parentRunId: parent?.runId ?? null,
    origin,
    status: "running",
    startedAt,
    finishedAt: null,
    elapsedMs: 0,
    processingMs: 0,
    approvalWaitMs,
    usage: emptyUsage(),
    turn: {
      startedAt: parent?.turn.startedAt ?? startedAt,
      completedAt: null,
      elapsedMs: parent ? Math.max(0, now.getTime() - Date.parse(parent.turn.startedAt)) : 0,
      processingMs: parent?.turn.processingMs ?? 0,
      approvalWaitMs: (parent?.turn.approvalWaitMs ?? 0) + approvalWaitMs,
      usage: parent?.turn.usage ?? emptyUsage(),
    },
  };
}
export function finishMetadata(
  start: RunMetadata,
  status: RunStatus,
  now: Date,
  processingMs: number,
  usage: TokenUsage,
): RunMetadata {
  return {
    ...start,
    status,
    finishedAt: status === "running" ? null : now.toISOString(),
    elapsedMs: processingMs,
    processingMs,
    usage,
    turn: {
      ...start.turn,
      completedAt: status === "paused" || status === "running" ? null : now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - Date.parse(start.turn.startedAt)),
      processingMs: start.turn.processingMs + processingMs,
      approvalWaitMs: start.turn.approvalWaitMs,
      usage: addUsage(start.turn.usage, usage),
    },
  };
}
