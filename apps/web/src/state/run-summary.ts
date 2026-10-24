import type { RunMetadata } from '../api/run-metadata';
import type { TranscriptTurn } from './transcript';

export function latestRun(turn: TranscriptTurn): RunMetadata | undefined {
  const event = turn.events.findLast(event => event.type === 'run');
  return event?.type === 'run' ? event.metadata : undefined;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** Display backend counts as snapshots, never sums of repeated SSE messages. */
export function runSummary(run: RunMetadata): string[] {
  const status = { completed: 'Completed', paused: 'Awaiting approval', failed: 'Failed', interrupted: 'Stopped', running: 'Working' }[run.status];
  const completedAt = run.turn.completedAt;
  const date = completedAt ? new Date(completedAt) : null;
  const time = date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const parts = [time ? `${status} at ${time}` : status, `${duration(run.turn.processingMs)} processing`];
  if (run.turn.approvalWaitMs > 0) parts.push(`${duration(run.turn.approvalWaitMs)} waiting for approval`);
  const usage = run.turn.usage;
  if (usage.availability === 'unavailable') parts.push('Token usage unavailable');
  else if (usage.totalTokens === null) parts.push('Token usage incomplete');
  else parts.push(`${usage.availability === 'partial' ? 'At least ' : ''}${usage.totalTokens.toLocaleString()} tokens`);
  return parts;
}

export function usageDetails(run: RunMetadata): string {
  const usage = run.turn.usage;
  const count = (value: number | null) => value === null ? 'unavailable' : value.toLocaleString();
  return [
    `Input: ${count(usage.inputTokens)} · Output: ${count(usage.outputTokens)}`,
    `Cached input: ${count(usage.cachedInputTokens)} · Reasoning output: ${count(usage.reasoningOutputTokens)} (subsets)`,
    `${usage.modelCalls} model calls · ${usage.availability} usage. Agent calls only; routing classifier excluded.`,
    run.turn.completedAt ? `Finished: ${run.turn.completedAt}` : 'This turn has not completed.',
  ].join('\n');
}
