import { z } from "zod";
import { McpGrantsSchema } from "../../mcp/grants";

/**
 * Explicitly selects capability names; nothing is inherited automatically.
 * An empty list grants no capabilities in that category.
 */
const toolSelection = z.array(z.string().trim().min(1)).superRefine((names, context) => {
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      message: "Capability names must be unique",
    });
  }
});

/**
 * Trusted configuration describing an agent's role and permitted capabilities.
 *
 * Definitions are registered by application code. User messages and model
 * output must never be accepted as agent definitions.
 */
export const AgentDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "Agent IDs must use lowercase letters, digits and hyphens",
      ),

    description: z.string().trim().min(1),
    instructions: z.string().trim().min(1),

    model: z.enum(["routed", "fast", "powerful"]),

    capabilities: z
      .object({
        /** Selections from the shared catalogue; omitted lists grant nothing. */
        useGlobalTools: toolSelection.default([]),
        /** Selections from this agent's private tool catalogue. */
        tools: toolSelection.default([]),
        useGlobalMcpServers: McpGrantsSchema.default([]),
        /** Selections from MCP profiles configured under this agent's ID. */
        mcp: McpGrantsSchema.default([]),
        skills: z.union([z.literal("all"), toolSelection]),

        /**
         * Controls both memory tools and memory included in the system prompt.
         * Tool filtering alone does not prevent prompt-based memory disclosure.
         */
        memory: z.enum(["none", "read", "read-write"]),
      })
      .strict(),
  })
  .strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
