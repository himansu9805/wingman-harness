import { z } from "zod";
import type { Interrupt } from "@langchain/langgraph";
import type { ToolRuntime } from "@langchain/core/tools";

export const ApprovalExecutionSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().uuid().nullable(),
  toolCallId: z.string().min(1),
});
export const CommandApprovalSchema = z.object({
  kind: z.literal("bash_approval"),
  command: z.string(),
  target: z.enum(["host", "sandbox"]).default("host"),
  execution: ApprovalExecutionSchema,
});
export type CommandApproval = z.infer<typeof CommandApprovalSchema>;
export const PendingApprovalSchema = CommandApprovalSchema.omit({ kind: true }).extend({
  id: z.string().min(1),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/** One parent interrupt transports a complete child approval batch. */
export const DelegatedApprovalSchema = z.object({
  kind: z.literal("delegated_approvals"),
  planId: z.string().uuid(),
  approvals: z.array(PendingApprovalSchema).min(1),
});
export type ApprovalPayload = CommandApproval | z.infer<typeof DelegatedApprovalSchema>;
const PayloadSchema = z.union([CommandApprovalSchema, DelegatedApprovalSchema]);
export type NativeApproval = Interrupt<ApprovalPayload>;

/** Ownership is injected from graph configuration, never supplied by model arguments. */
export function commandApproval(
  command: string,
  runtime: ToolRuntime,
  target: "host" | "sandbox" = "sandbox",
): CommandApproval {
  return CommandApprovalSchema.parse({
    kind: "bash_approval",
    command,
    target,
    execution: {
      agentId: runtime.config.configurable?.agent_id,
      taskId: runtime.config.configurable?.delegated_task_id ?? null,
      toolCallId: runtime.toolCallId,
    },
  });
}

/** Flatten bridge batches without trusting or parsing user-provided composite IDs. */
export function pendingApprovals(interrupts: readonly NativeApproval[]): PendingApproval[] {
  return interrupts.flatMap((item) => {
    if (!item.id) throw new Error("Approval interrupt has no persisted ID");
    const value = PayloadSchema.parse(item.value);
    return value.kind === "bash_approval"
      ? [{ id: item.id, command: value.command, target: value.target, execution: value.execution }]
      : value.approvals.map((approval) => ({ ...approval, id: `${item.id}:${approval.id}` }));
  });
}

/** Validates the exact pending batch and builds native resume values for each owner. */
export function approvalAnswers(
  interrupts: readonly NativeApproval[],
  answers: Record<string, boolean>,
) {
  const pending = pendingApprovals(interrupts);
  if (!pending.length) throw new Error("Nothing is waiting for approval");
  const ids = new Set(pending.map((item) => item.id));
  if (
    Object.keys(answers).length !== ids.size ||
    !Object.entries(answers).every(([id, answer]) => ids.has(id) && typeof answer === "boolean")
  ) {
    throw new Error("Answer every pending approval exactly once");
  }
  return Object.fromEntries(
    interrupts.map((item) => {
      const value = PayloadSchema.parse(item.value);
      return [
        item.id!,
        value.kind === "bash_approval"
          ? answers[item.id!]
          : Object.fromEntries(
              value.approvals.map((approval) => [
                approval.id,
                answers[`${item.id}:${approval.id}`],
              ]),
            ),
      ];
    }),
  );
}
