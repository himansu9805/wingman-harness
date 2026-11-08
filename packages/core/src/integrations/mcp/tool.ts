import { tool, type ToolRuntime, type StructuredToolInterface } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/** Convert all MCP content variants while retaining the original protocol result as an artifact. */
function modelContent(block: ContentBlock): Exclude<ToolMessage["content"], string>[number] {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      };
    case "audio":
      return { type: "audio", source_type: "base64", mime_type: block.mimeType, data: block.data };
    case "resource_link":
      return {
        type: "text",
        text: JSON.stringify({
          name: block.name,
          uri: block.uri,
          description: block.description,
          mimeType: block.mimeType,
        }),
      };
    case "resource":
      return {
        type: "text",
        text: JSON.stringify({
          uri: block.resource.uri,
          mimeType: block.resource.mimeType,
          ...("text" in block.resource
            ? { text: block.resource.text }
            : { content: "Binary resource retained in the tool artifact" }),
        }),
      };
  }
}

/** Adapt explicit MCP responses without conflating server errors with lost transport. */
export function responseTool(
  definition: StructuredToolInterface,
  call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>,
): StructuredToolInterface {
  return tool(
    async (args, runtime: ToolRuntime) => {
      const id = runtime.toolCallId ?? runtime.toolCall?.id;
      if (!id) throw new Error("MCP execution requires a stable tool call ID");
      // A thrown transport error deliberately propagates: execution may have happened.
      const result = await call(args, runtime.config?.signal ?? runtime.signal);
      const content = result.content.map(modelContent);
      if (!content.length && result.structuredContent)
        content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
      return new ToolMessage({
        name: definition.name,
        tool_call_id: id,
        content,
        status: result.isError ? "error" : "success",
        artifact: result,
      });
    },
    { name: definition.name, description: definition.description, schema: definition.schema },
  );
}
