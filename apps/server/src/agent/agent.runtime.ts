import type { Agent } from "@wingman/core";

export const AGENT_RUNTIME = Symbol("AGENT_RUNTIME");

/** Supplies the agent lifecycle independently of the HTTP handlers. */
export interface AgentRuntime {
  create(): Promise<Agent>;
  close(): Promise<void>;
}

export const agentRuntime: AgentRuntime = {
  async create() {
    const { Agent } = await import("@wingman/core");
    return Agent.create();
  },
  async close() {
    const { shutdown } = await import("@wingman/core");
    await shutdown();
  },
};
