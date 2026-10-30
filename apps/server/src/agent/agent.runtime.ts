import type { Agent, JobDispatcher, TaskRun } from "@wingman/core";

export const AGENT_RUNTIME = Symbol("AGENT_RUNTIME");

/** Supplies the agent lifecycle independently of the HTTP handlers. */
export interface AgentRuntime {
  create(): Promise<Agent>;
  schedulerEnabled(): Promise<boolean>;
  listTasks(limit: number, before?: string): Promise<Awaited<ReturnType<typeof import("@wingman/core/tasks").listTaskPage>>>;
  scheduledThreadIds(ids: string[]): Promise<string[]>;
  cancelTask(id: string): Promise<boolean>;
  taskRuns(limit: number, jobId?: string, before?: string): Promise<Awaited<ReturnType<typeof import("@wingman/core/tasks").getTaskRunPage>>>;
  close(): Promise<void>;
  startScheduler(dispatch: JobDispatcher): Promise<void>;
  stopScheduler(): Promise<void>;
  recordRun(run: TaskRun): Promise<void>;
}

export const agentRuntime: AgentRuntime = {
  async schedulerEnabled() { return (await import("@wingman/core")).settings.SCHEDULER_ENABLED; },
  async listTasks(limit, before) { return (await import("@wingman/core/tasks")).listTaskPage(limit, before); },
  async scheduledThreadIds(ids) { return (await import("@wingman/core/tasks")).getScheduledThreadIds(ids); },
  async cancelTask(id) { return (await import("@wingman/core/tasks")).cancelTask(id); },
  async taskRuns(limit, jobId, before) { return (await import("@wingman/core/tasks")).getTaskRunPage(limit, jobId, before); },
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
