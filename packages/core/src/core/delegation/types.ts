import { z } from "zod";
import type { StoredMessage } from "@langchain/core/messages";
import { PendingApprovalSchema } from "../approvals";

/** Model arguments contain task data only; the harness injects all execution identity. */
export const DelegationRequestSchema = z
  .object({
    agentId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    objective: z.string().trim().min(1).max(4000),
    context: z.string().max(20000),
  })
  .strict();
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
});
const StoredToolSchema = z.custom<StoredMessage>((value) => {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "tool" ||
    !("data" in value)
  )
    return false;
  const data = value.data;
  return (
    !!data &&
    typeof data === "object" &&
    "content" in data &&
    "tool_call_id" in data &&
    typeof data.tool_call_id === "string" &&
    (typeof data.content === "string" || Array.isArray(data.content))
  );
});
export const ToolLedgerSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string(),
  hash: z.string(),
  status: z.enum(["running", "waiting_approval", "completed", "uncertain"]),
  ownerToken: z.string().uuid(),
  result: StoredToolSchema.nullable(),
});

/** State, ownership and budgets are durable across approval pauses and process restarts. */
export const DelegatedTaskSchema = z.object({
  parentAgentId: z.string().min(1),
  schedulerThreadId: z.string().nullable(),
  taskId: z.string().uuid(),
  conversationId: z.string().min(1).max(1000),
  parentExecutionId: z.string().min(1).max(1000),
  parentToolCallId: z.string().min(1).max(1000),
  checkpointThreadId: z.string(),
  requestHash: z.string(),
  request: DelegationRequestSchema,
  status: z.enum([
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "recovery_required",
  ]),
  output: z.string().max(16000).nullable(),
  truncated: z.boolean(),
  error: z.string().max(2000).nullable(),
  version: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  ownerToken: z.string().uuid().nullable(),
  leaseExpiresAt: z.string().nullable(),
  fingerprint: z.string().nullable(),
  attemptStartedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  processingMs: z.number().nonnegative(),
  approvalWaitMs: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  pendingApprovals: z.array(PendingApprovalSchema).max(32),
  approvalRounds: z
    .array(
      z.object({
        approvals: z.array(PendingApprovalSchema).min(1).max(32),
        answers: z.record(z.string(), z.boolean()).nullable(),
      }),
    )
    .max(100),
  usage: z.array(z.object({ id: z.string(), usage: UsageSchema })).max(100),
  tools: z.array(ToolLedgerSchema).max(32),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>;
export type DelegationIdentity = Pick<
  DelegatedTask,
  "conversationId" | "parentExecutionId" | "parentToolCallId"
>;
export const DelegationEventSchema = z.object({
  type: z.literal("delegation"),
  phase: z.enum([
    "started",
    "waiting_approval",
    "resumed",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "recovery_required",
    "reused",
    "blocked",
  ]),
  taskId: z.string().uuid(),
  agentId: z.string(),
  conversationId: z.string(),
  parentExecutionId: z.string(),
  parentToolCallId: z.string(),
});
export type DelegationEvent = z.infer<typeof DelegationEventSchema>;
const ActivitySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    args: z.unknown(),
    toolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("memory"),
    name: z.string(),
    args: z.unknown(),
    toolCallId: z.string().optional(),
  }),
  z.object({ type: z.literal("skill"), name: z.string(), toolCallId: z.string().optional() }),
  z.object({
    type: z.literal("tool_result"),
    name: z.string(),
    toolCallId: z.string(),
    output: z.string(),
    truncated: z.boolean(),
  }),
]);
export const DelegationActivitySchema = z.object({
  type: z.literal("agent_activity"),
  taskId: z.string().uuid(),
  agentId: z.string(),
  event: ActivitySchema,
});
export type DelegationActivity = z.infer<typeof DelegationActivitySchema>;
export const DelegationStreamSchema = z.discriminatedUnion("type", [
  DelegationEventSchema,
  DelegationActivitySchema,
  z.object({
    type: z.literal("delegation_usage"),
    taskId: z.string().uuid(),
    index: z.number().int().nonnegative(),
    usage: UsageSchema,
  }),
]);
export type DelegationStream = z.infer<typeof DelegationStreamSchema>;
export class DelegationRejected extends Error {}
export class DelegationBusyError extends Error {
  readonly code = "DELEGATION_BUSY";
}
export class RecoveryRequired extends Error {}
