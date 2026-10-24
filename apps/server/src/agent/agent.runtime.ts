import type { Agent, JobDispatcher, TaskRun } from "@wingman/core";

export const AGENT_RUNTIME = Symbol("AGENT_RUNTIME");

/** Supplies the agent lifecycle independently of the HTTP handlers. */
export interface AgentRuntime {
  create(): Promise<Agent>;
  close(): Promise<void>;
  startScheduler(dispatch: JobDispatcher): Promise<void>;
  stopScheduler(): Promise<void>;
  recordRun(run: TaskRun): Promise<void>;
}

export const agentRuntime: AgentRuntime = {
  async create() {
    const { Agent } = await import("@wingman/core");
    return Agent.create();
  },
  async startScheduler(dispatch) {
    const core = await import("@wingman/core");
    if (core.settings.SCHEDULER_ENABLED) await core.startScheduler(dispatch);
  },
  async stopScheduler() {
    const { closeScheduler } = await import("@wingman/core");
    await closeScheduler();
  },
  async recordRun(run) {
    const { recordRun } = await import("@wingman/core");
    await recordRun(run);
  },
  async close() {
    const { shutdown } = await import("@wingman/core");
    await shutdown();
  },
};
