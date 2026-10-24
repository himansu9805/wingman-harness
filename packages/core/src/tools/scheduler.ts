import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  cancelTask,
  listTasks,
  scheduleOnce,
  scheduleRecurring,
} from "../scheduler/scheduler";
import { getRecentRuns } from "../scheduler/results";

const scheduleTask = tool(
  async ({ prompt, when }, config) => {
    try {
      const id = await scheduleOnce(when, { prompt, ...(config.configurable?.scheduler_thread_id ? { threadId: String(config.configurable.scheduler_thread_id) } : {}) });
      return `Scheduled task ${id} for ${when}. Tell the user what was scheduled and when.`;
    } catch (err) {
      return `Could not schedule task: ${(err as Error).message}`;
    }
  },
  {
    name: "schedule_task",
    description:
      "Schedules something to happen once, later. Use for reminders and " +
      "delayed actions, e.g. 'remind me in 10 minutes to stretch'. When it " +
      "fires, you receive the prompt as a new task and carry it out. For " +
      "things that repeat, use schedule_recurring_task instead.",
    schema: z.object({
      prompt: z
        .string()
        .describe(
          'A full sentence saying what to do when the task fires, starting with a verb. Good: "Tell the user it\'s time to drink water." Bad: "drink water" or "Remind the user to drink water." It runs in a new conversation with no memory of this one, so include every detail needed.',
        ),
      when: z
        .string()
        .describe(
          "When to run: a relative time like 'in 10 minutes', a clock time like '11:03 AM', or an ISO date-time like '2026-10-12T09:00:00'. Work it out from the current date and time.",
        ),
    }),
  },
);

const scheduleRecurringTask = tool(
  async ({ prompt, interval }, config) => {
    try {
      const id = await scheduleRecurring(interval, { prompt, ...(config.configurable?.scheduler_thread_id ? { threadId: String(config.configurable.scheduler_thread_id) } : {}) });
      return `Scheduled recurring task ${id} (${interval}). Tell the user what was scheduled and how often.`;
    } catch (err) {
      return `Could not schedule recurring task: ${(err as Error).message}`;
    }
  },
  {
    name: "schedule_recurring_task",
    description:
      "Schedules something that repeats on a fixed schedule, e.g. 'every " +
      "morning at 9, check if postgres is running'. Each time it fires, you " +
      "receive the prompt as a new task. For a one-off reminder, use " +
      "schedule_task instead.",
    schema: z.object({
      prompt: z
        .string()
        .describe(
          'A full sentence saying what to do when the task fires, starting with a verb. Good: "Tell the user it\'s time to drink water." Bad: "drink water" or "Remind the user to drink water." It runs in a new conversation with no memory of this one, so include every detail needed.',
        ),
      interval: z
        .string()
        .describe(
          "How often: a cron expression like '0 9 * * *' (every day at 09:00) or '*/30 * * * *' (every 30 minutes), or an interval like '30 minutes' or '2 hours'.",
        ),
    }),
  },
);

const listScheduledTasks = tool(
  async () => {
    const tasks = await listTasks();
    return tasks.length > 0
      ? JSON.stringify(tasks, null, 2)
      : "No tasks are scheduled.";
  },
  {
    name: "list_scheduled_tasks",
    description:
      "Lists every scheduled task: its ID, prompt, next run time and repeat " +
      "interval. Use it to answer 'what's scheduled?', or to find a task's " +
      "ID before cancelling it or showing its runs.",
    schema: z.object({}),
  },
);

const cancelScheduledTask = tool(
  async ({ id }) =>
    (await cancelTask(id))
      ? `Cancelled task ${id}.`
      : `No task found with ID ${id}. Call list_scheduled_tasks to see the current IDs.`,
  {
    name: "cancel_scheduled_task",
    description:
      "Cancels a scheduled task so it never runs again. Needs the task's ID: " +
      "call list_scheduled_tasks first if you don't have it. If several " +
      "tasks could match what the user means, ask which one.",
    schema: z.object({
      id: z
        .string()
        .describe("The task ID exactly as list_scheduled_tasks returned it."),
    }),
  },
);

const showScheduledTaskRuns = tool(
  async ({ jobId, limit }) => {
    const runs = await getRecentRuns(jobId, limit);
    return runs.length > 0
      ? JSON.stringify(runs, null, 2)
      : "No runs found. The task may not have fired yet.";
  },
  {
    name: "show_scheduled_task_runs",
    description:
      "Shows past runs of scheduled tasks, newest first: when each ran, " +
      "whether it succeeded, and what it produced. Use it for questions like " +
      "'did my backup check run?' or 'what did the 9am task say?'. Leave " +
      "jobId out to see runs of all tasks.",
    schema: z.object({
      jobId: z
        .string()
        .optional()
        .describe(
          "Only show runs of this task ID, from list_scheduled_tasks. Leave out for all tasks.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("How many runs to return, 1 to 100. Defaults to 10."),
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
