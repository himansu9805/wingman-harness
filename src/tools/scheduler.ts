import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  cancelTask,
  listTasks,
  scheduleOnce,
  scheduleRecurring,
} from "@/scheduler/scheduler";
import { getRecentRuns } from "@/scheduler/results";

const scheduleTask = tool(
  async ({ prompt, when }) => {
    try {
      const id = await scheduleOnce(when, { prompt });
      return `Scheduled task ${id} for ${when}`;
    } catch (err) {
      return `Could not schedule task: ${(err as Error).message}`;
    }
  },
  {
    name: "schedule_task",
    description:
      "Schedules a one-off task for you to run later. The prompt runs in a " +
      "fresh conversation, so it must be self-contained.",
    schema: z.object({
      prompt: z
        .string()
        .describe("The instruction to run when the task fires."),
      when: z
        .string()
        .describe("When to run, e.g. 'in 10 minutes', or an ISO date"),
    }),
  },
);

const scheduleRecurringTask = tool(
  async ({ prompt, interval }) => {
    try {
      const id = await scheduleRecurring(interval, { prompt });
      return `Scheduled recurring task ${id} every ${interval}`;
    } catch (err) {
      return `Could not schedule recurring task: ${(err as Error).message}`;
    }
  },
  {
    name: "schedule_recurring_task",
    description:
      "Schedules a task that repeats. The prompt runs in a fresh " +
      "conversation each time, so it must be self-contained.",
    schema: z.object({
      prompt: z.string().describe("The full instruction to run each time."),
      interval: z
        .string()
        .describe(
          "A cron expression or interval, e.g. '0 9 * * *' or '30 minutes'",
        ),
    }),
  },
);

const listScheduledTasks = tool(
  async () => JSON.stringify(await listTasks(), null, 2),
  {
    name: "list_scheduled_tasks",
    description:
      "Lists every scheduled task with its ID, prompt and next run time.",
    schema: z.object({}),
  },
);

const cancelScheduledTask = tool(
  async ({ id }) =>
    (await cancelTask(id))
      ? `Cancelled task ${id}.`
      : `No task found with ID ${id}.`,
  {
    name: "cancel_scheduled_task",
    description:
      "Cancels a scheduled task by ID. Use list_scheduled_tasks to find IDs.",
    schema: z.object({
      id: z.string().describe("The task ID from list_scheduled_tasks"),
    }),
  },
);

const showScheduledTaskRuns = tool(
  async ({ jobId, limit }) => {
    const runs = await getRecentRuns(jobId, limit);
    return JSON.stringify(runs, null, 2);
  },
  {
    name: "show_scheduled_task_runs",
    description:
      "Shows the most recent runs of a scheduled task, optionally filtered by job ID.",
    schema: z.object({
      jobId: z.string().optional().describe("The job ID to filter by."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("The maximum number of runs to return."),
    }),
  },
);

export const schedulerTools = [
  scheduleTask,
  scheduleRecurringTask,
  listScheduledTasks,
  cancelScheduledTask,
  showScheduledTaskRuns,
];
