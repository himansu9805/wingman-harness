import type { ModelUsage } from "@wingman/core/turns";

export interface TokenUsage extends ModelUsage {
  scope: "agent";
  modelCalls: number;
  reportedCalls: number;
  missingCalls: number;
  availability: "complete" | "partial" | "unavailable";
}
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
const fields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"] as const;
export function emptyUsage(): TokenUsage {
  return { scope: "agent", modelCalls: 0, reportedCalls: 0, missingCalls: 0, availability: "unavailable",
    inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningOutputTokens: null };
}
export function addUsage(total: TokenUsage, next: ModelUsage | TokenUsage): TokenUsage {
  const aggregate = "modelCalls" in next;
  const reported = [next.inputTokens, next.outputTokens, next.totalTokens].some(value => value !== null);
  const complete = [next.inputTokens, next.outputTokens, next.totalTokens].every(value => value !== null);
  const result = { ...total,
    modelCalls: total.modelCalls + (aggregate ? next.modelCalls : 1),
    reportedCalls: total.reportedCalls + (aggregate ? next.reportedCalls : Number(reported)),
    missingCalls: total.missingCalls + (aggregate ? next.missingCalls : Number(!complete)),
  };
  for (const field of fields) result[field] = total[field] === null && next[field] === null
    ? null : (total[field] ?? 0) + (next[field] ?? 0);
  result.availability = result.reportedCalls === 0 ? "unavailable" : result.missingCalls > 0 ? "partial" : "complete";
  return result;
}

/** The event journal is authoritative; resume correlation survives process restarts. */
export function startMetadata(runId: string, origin: RunMetadata["origin"], now: Date, previous?: RunMetadata): RunMetadata {
  const parent = origin === "resume" && previous?.status === "paused" ? previous : undefined;
  const startedAt = now.toISOString();
  const approvalWaitMs = parent?.finishedAt ? Math.max(0, now.getTime() - Date.parse(parent.finishedAt)) : 0;
  return { runId, turnId: parent?.turnId ?? runId, parentRunId: parent?.runId ?? null, origin, status: "running",
    startedAt, finishedAt: null, elapsedMs: 0, processingMs: 0,
    approvalWaitMs,
    usage: emptyUsage(),
    turn: { startedAt: parent?.turn.startedAt ?? startedAt, completedAt: null, elapsedMs: parent ? Math.max(0, now.getTime() - Date.parse(parent.turn.startedAt)) : 0,
      processingMs: parent?.turn.processingMs ?? 0,
      approvalWaitMs: (parent?.turn.approvalWaitMs ?? 0) + approvalWaitMs, usage: parent?.turn.usage ?? emptyUsage() },
  };
}
export function finishMetadata(start: RunMetadata, status: RunStatus, now: Date, processingMs: number, usage: TokenUsage): RunMetadata {
  return { ...start, status, finishedAt: status === "running" ? null : now.toISOString(), elapsedMs: processingMs, processingMs, usage,
    turn: { ...start.turn, completedAt: (status === "paused" || status === "running") ? null : now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - Date.parse(start.turn.startedAt)),
      processingMs: start.turn.processingMs + processingMs,
      approvalWaitMs: start.turn.approvalWaitMs,
      usage: addUsage(start.turn.usage, usage) },
  };
}
