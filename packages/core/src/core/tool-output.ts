import type { ToolMessage } from "@langchain/core/messages";

const MAX_TOOL_OUTPUT_LENGTH = 10_000;

/** Returns the same bounded preview for streamed results and saved history. */
export function previewToolOutput(
  content: ToolMessage["content"],
): { output: string; truncated: boolean } {
  const output = typeof content === "string" ? content : JSON.stringify(content);
  return {
    output: output.slice(0, MAX_TOOL_OUTPUT_LENGTH),
    truncated: output.length > MAX_TOOL_OUTPUT_LENGTH,
  };
}
