import type { Agenda, Job } from "agenda";
import type { AgentTaskData, JobDispatcher, ScheduledEvent } from "@/scheduler/interfaces";

export const AGENT_TASK_JOB = "agent-task";

/**
 * Registers every job handler on the scheduler.
 *
 * Must run before `agenda.start()`.
 *
 * @param agenda The scheduler to register jobs on.
 * @param dispatch Runs the agent turn for a fired job.
 */
export function defineJobs(agenda: Agenda, dispatch: JobDispatcher) {
  agenda.define<AgentTaskData>(
    AGENT_TASK_JOB,
    async (job: Job<AgentTaskData>) => {
      const { prompt, threadId } = job.attrs.data;
      const jobId = String(job.attrs._id);

      // Awaiting the turn keeps the job locked until the agent finishes, so a
      // slow turn isn't picked up by another poll.
      await dispatch({
        jobId,
        prompt,
        threadId: threadId ?? `scheduled-${jobId}`,
      });
    },
    {
      // Turns share one agent; run them one at a time.
      concurrency: 1,
      // Agent turns (tool calls, MCP) can take minutes.
      lockLifetime: 10 * 60 * 1000,
    },
  );
}
