import { z } from "zod";

/** Stable profile IDs also form the server portion of exposed tool names. */
export const McpServerIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

/** Tool names here are the original names reported by the selected server. */
const toolSelection = z.union([
  z.literal("all"),
  z.array(z.string().trim().min(1)).superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "MCP tool names must be unique" });
    }
  }),
]);

/**
 * Grants access to tools from one trusted connection profile.
 * "all" opts into every discovered tool on that server; explicit lists are
 * checked against original server tool names, before namespace prefixes.
 */
export const McpGrantSchema = z
  .object({
    serverId: McpServerIdSchema,
    tools: toolSelection,
  })
  .strict();

/** A profile can appear once; an empty list grants no MCP access. */
export const McpGrantsSchema = z.array(McpGrantSchema).superRefine((grants, context) => {
  const ids = grants.map((grant) => grant.serverId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "MCP server grants must be unique" });
  }
});

export type McpGrant = z.infer<typeof McpGrantSchema>;
export interface RegisteredMcpGrant {
  readonly serverId: string;
  readonly tools: "all" | readonly string[];
}
