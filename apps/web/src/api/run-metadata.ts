/** Matches the backend run metadata API contract. */
interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

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
