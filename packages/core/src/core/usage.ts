import { z } from "zod";
import type { AIMessage } from "@langchain/core/messages";

/** Provider-reported counts; null means unavailable, never a guessed zero. */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export function modelUsage(message: AIMessage): ModelUsage {
  const usage = message.usage_metadata;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    totalTokens: count(usage?.total_tokens),
    cachedInputTokens: count(usage?.input_token_details?.cache_read),
    reasoningOutputTokens: count(usage?.output_token_details?.reasoning),
  };
}

export interface TokenUsage extends ModelUsage {
  scope: "agent";
  modelCalls: number;
  reportedCalls: number;
  missingCalls: number;
  availability: "complete" | "partial" | "unavailable";
}

const fields = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
] as const;
export function emptyUsage(): TokenUsage {
  return {
    scope: "agent",
    modelCalls: 0,
    reportedCalls: 0,
    missingCalls: 0,
    availability: "unavailable",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  };
}
export function addUsage(total: TokenUsage, next: ModelUsage | TokenUsage): TokenUsage {
  const aggregate = "modelCalls" in next;
  const reported = [next.inputTokens, next.outputTokens, next.totalTokens].some(
    (value) => value !== null,
  );
  const complete = [next.inputTokens, next.outputTokens, next.totalTokens].every(
    (value) => value !== null,
  );
  const result = {
    ...total,
    modelCalls: total.modelCalls + (aggregate ? next.modelCalls : 1),
    reportedCalls: total.reportedCalls + (aggregate ? next.reportedCalls : Number(reported)),
    missingCalls: total.missingCalls + (aggregate ? next.missingCalls : Number(!complete)),
  };
  for (const field of fields)
    result[field] =
      total[field] === null && next[field] === null
        ? null
        : (total[field] ?? 0) + (next[field] ?? 0);
  result.availability =
    result.reportedCalls === 0 ? "unavailable" : result.missingCalls > 0 ? "partial" : "complete";
  return result;
}

/** Runtime validation for provider counts and inclusive agent totals. */
export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
});
export const TokenUsageSchema = ModelUsageSchema.extend({
  scope: z.literal("agent"),
  modelCalls: z.number().int().nonnegative(),
  reportedCalls: z.number().int().nonnegative(),
  missingCalls: z.number().int().nonnegative(),
  availability: z.enum(["complete", "partial", "unavailable"]),
});
