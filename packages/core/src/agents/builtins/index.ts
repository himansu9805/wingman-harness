import type { AgentModule } from "../module";
import { createOrchestratorAgentDefinition } from "./orchestrator";
import { analystAgentDefinition } from "./analyst";
import { coderAgentDefinition } from "./coder";
import { researcherAgentModule } from "./researcher";

export { createOrchestratorAgentDefinition, analystAgentDefinition, coderAgentDefinition };
export { researcherAgentDefinition, researcherAgentModule } from "./researcher";

/** The single registration point for built-in role modules. */
export function builtinAgentModules(schedulerEnabled: boolean): AgentModule[] {
  return [
    { definition: createOrchestratorAgentDefinition(schedulerEnabled) },
    { definition: analystAgentDefinition, delegatedBy: ["orchestrator"] },
    { definition: coderAgentDefinition, delegatedBy: ["orchestrator"] },
    researcherAgentModule,
  ];
}
