import { Agenda } from "agenda";
import { PostgresBackend } from "@agendajs/postgres-backend";
import { settings } from "@/settings";
import type { AgentTaskData, JobDispatcher } from "@/scheduler/interfaces";
import { AGENT_TASK_JOB, defineJobs } from "@/scheduler/jobs";

let agenda: Agenda | null = null;
let started = false;

/**
 * Returns the shared scheduler, creating it on first use.
 *
 * @returns The `Agenda` instance.
 */
function getScheduler(): Agenda {
  agenda ??= new Agenda({
    backend: new PostgresBackend({
      connectionString: settings.POSTGRES_CONNECTION_STRING,
    }),
  });
  return agenda;
}

/**
 * Registers job handlers and starts processing due jobs.
 *
 * @param dispatch Runs the agent turn for a fired job.
 */
export async function startScheduler(dispatch: JobDispatcher): Promise<void> {
  if (started) return;
  const scheduler = getScheduler();
  defineJobs(scheduler, dispatch);
  scheduler.on("error", (err) => console.warn(`[scheduler] ${err.message}`));
  await scheduler.start();
  started = true;
}

/**
 * Stops processing and closes the database connection.
 */
export async function closeScheduler(): Promise<void> {
  if (agenda) {
    await agenda.stop();
    agenda = null;
    started = false;
  }
}

/**
 * Schedules a one-off agent task.
 *
 * @param when A date or human interval, e.g. "in 10 minutes", "tomorrow at 9 am."
 * @param data The task to run.
 * @returns The new job's ID.
 */
export async function scheduleOnce(
  when: string | Date,
  data: AgentTaskData,
): Promise<string> {
  const job = await getScheduler().schedule(when, AGENT_TASK_JOB, data);
  return String(job.attrs._id);
}

/**
 * Schedules a recurring agent task.
 *
 * @param interval A cron expression or human interval, e.g. "0 9 * * *", "5 minutes".
 * @param data The task to run.
 * @returns The new job's ID.
 */
export async function scheduleRecurring(
  interval: string,
  data: AgentTaskData,
): Promise<string> {
  // Not `every()`: it saves jobs as type "single", which upserts by name, so
  // every agent-task would overwrite the last. A normal job keyed on the
  // prompt lets several recurring tasks coexist.
  const job = getScheduler()
    .create(AGENT_TASK_JOB, data)
    .repeatEvery(interval)
    .unique({ "data.prompt": data.prompt });
  await job.save();
  return String(job.attrs._id);
}

/**
 * Lists every scheduled agent task.
 */
export async function listTasks() {
  const { jobs } = await getScheduler().queryJobs({ name: AGENT_TASK_JOB });
  return jobs.map((job) => ({
    id: String(job._id),
    prompt: (job.data as AgentTaskData).prompt,
    nextRunAt: job.nextRunAt,
    repeatInterval: job.repeatInterval ?? null,
    state: job.state,
  }));
}

/**
 * Cancels a scheduled task.
 *
 * @param id The job ID.
 * @returns Whether a job was removed.
 */
export async function cancelTask(id: string): Promise<boolean> {
  return (await getScheduler().cancel({ id })) > 0;
}
