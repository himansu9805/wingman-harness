import cronstrue from "cronstrue";

/** Format a next-run timestamp in local time, with labels for missing or invalid dates. */
export function taskTime(value: string | null): string {
  if (!value) return "No next run";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "Time unavailable";
}

/** Describe a cron schedule, preserving natural-language intervals when cron parsing fails. */
export function scheduleDescription(interval: string | null): string {
  if (!interval) return "One-time task";
  try {
    return cronstrue.toString(interval, { verbose: true, trimHoursLeadingZero: true });
  } catch {
    return interval;
  }
}
