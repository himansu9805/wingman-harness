import cronstrue from 'cronstrue';

export function taskTime(value: string | null): string {
  if (!value) return 'No next run';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable';
}

export function scheduleDescription(interval: string | null): string {
  if (!interval) return 'One-time task';
  try { return cronstrue.toString(interval, { verbose: true, trimHoursLeadingZero: true }); }
  catch { return interval; }
}
