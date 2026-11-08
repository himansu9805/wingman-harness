import type { RegisteredAgentDefinition } from "../agents/registry";

/** Specialists choose a processing budget; coordinators impose the upper bound. */
export function workerBudget(parent: RegisteredAgentDefinition, child: RegisteredAgentDefinition) {
  return {
    timeoutMs: Math.min(
      parent.delegation.timeoutMs,
      child.execution?.timeoutMs ?? parent.delegation.timeoutMs,
    ),
    maxModelCalls: Math.min(
      parent.delegation.maxModelCalls,
      child.execution?.maxModelCalls ?? parent.delegation.maxModelCalls,
    ),
  };
}
