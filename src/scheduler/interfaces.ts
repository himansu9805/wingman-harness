/** Data stored with every agent-task job. */
export interface AgentTaskData {
  /** The instruction the agent runs when the job fires. */
  prompt: string;
  /** Conversation to run in; defaults to per-job thread when ommited. */
  threadId?: string;
}

/** A fired job, handed to whoever runs the agent turns (the turn queue). */
export interface ScheduledEvent {
  jobId: string;
  prompt: string;
  threadId: string;
}

export interface TaskRun {
  jobId: string;
  prompt: string;
  threadId: string;
  status: "success" | "failed" | "interrupted";
  output?: string;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
}

export type JobDispatcher = (event: ScheduledEvent) => Promise<void>;
