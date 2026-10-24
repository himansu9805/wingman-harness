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
