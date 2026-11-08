import type { TokenUsage } from "./run-metadata";

export interface DelegationTask {
  key: string;
  agentId: string;
  taskId: string | null;
  objective: string;
  dependsOn: string[];
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "blocked"
    | "interrupted"
    | "cancelled"
    | "recovery_required";
  output: string | null;
  truncated: boolean;
  error: string | null;
  toolCount: number;
  decisions: { toolCallId: string; approved: boolean }[];
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  processingMs: number;
  approvalWaitMs: number;
  usage: TokenUsage;
}
/** Inclusive task snapshots are replaced, never accumulated on replay. */
export interface DelegationPlanSnapshot {
  type: "delegation_plan";
  planId: string;
  conversationId: string;
  parentExecutionId: string;
  parentToolCallId: string;
  status:
    | "running"
    | "waiting_approval"
    | "completed"
    | "partial"
    | "failed"
    | "cancelling"
    | "cancelled"
    | "recovery_required";
  tasks: DelegationTask[];
  startedAt: string;
  finishedAt: string | null;
  asOf: string;
  elapsedMs: number;
  error: string | null;
}
