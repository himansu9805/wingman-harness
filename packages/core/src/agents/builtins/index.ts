import type { AgentModule } from "../module";
import type { McpConnections } from "../../integrations/mcp/client";
import { createDefaultAgentDefinition } from "./coordinator";
import { analystAgentDefinition } from "./analyst";
import { operatorAgentDefinition } from "./operator";
import { createBrowserAgentModule } from "./browser";

export { createDefaultAgentDefinition, analystAgentDefinition, operatorAgentDefinition };

/** The single registration point for built-in role modules. */
export function builtinAgentModules(schedulerEnabled: boolean, mcp: McpConnections): AgentModule[] {
  return [
    { definition: createDefaultAgentDefinition(schedulerEnabled) },
    { definition: analystAgentDefinition, delegatedBy: ["default"] },
    { definition: operatorAgentDefinition, delegatedBy: ["default"] },
    createBrowserAgentModule(mcp),
  ];
}
