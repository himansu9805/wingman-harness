import { z } from "zod";

/** Model-supplied task data only; execution identity is injected by the harness. */
export const DelegationRequestSchema = z.object({
  agentId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  objective: z.string().trim().min(1).max(4000),
  context: z.string().max(20000),
}).strict();
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
});

/** Durable identity survives parent tool replay without overloading API run IDs. */
export const DelegatedTaskSchema = z.object({
  taskId: z.string().uuid(),
  conversationId: z.string().min(1).max(1000),
  parentExecutionId: z.string().min(1).max(1000),
  parentToolCallId: z.string().min(1).max(1000),
  checkpointThreadId: z.string(),
  requestHash: z.string(),
  request: DelegationRequestSchema,
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  output: z.string().max(16000).nullable(),
  truncated: z.boolean(),
  error: z.string().max(2000).nullable(),
  usage: z.array(UsageSchema).max(1),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>;
export type DelegationIdentity = Pick<DelegatedTask, "conversationId" | "parentExecutionId" | "parentToolCallId">;
export type TaskFinish = Pick<DelegatedTask, "output" | "truncated" | "error" | "finishedAt"> & {
  status: Exclude<DelegatedTask["status"], "running">;
};

/** Progress is delivered on the originating conversation, never a child catalogue thread. */
export const DelegationEventSchema = z.object({
  type: z.literal("delegation"),
  phase: z.enum(["started", "completed", "failed", "interrupted", "reused", "blocked"]),
  taskId: z.string().uuid(),
  agentId: z.string(),
  conversationId: z.string(),
  parentExecutionId: z.string(),
  parentToolCallId: z.string(),
});
export type DelegationEvent = z.infer<typeof DelegationEventSchema>;

/** Internal custom stream frames carry new child usage to the existing accumulator. */
export const DelegationStreamSchema = z.discriminatedUnion("type", [
  DelegationEventSchema,
  z.object({ type: z.literal("delegation_usage"), taskId: z.string().uuid(), index: z.number().int().nonnegative(), usage: UsageSchema }),
]);
export type DelegationStream = z.infer<typeof DelegationStreamSchema>;

/** Expected policy failures can be shown to the coordinator without leaking infrastructure errors. */
export class DelegationRejected extends Error {}
