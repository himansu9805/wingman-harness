import type { ThreadEvent, ToolCall } from '../api/types';

export type RunPhase = 'idle' | 'running' | 'paused' | 'done' | 'error';
export interface Activity { phase: RunPhase; runId?: string; events: ThreadEvent[] }
export const emptyActivity: Activity = { phase: 'idle', events: [] };

export function applyEvent(state: Activity, event: ThreadEvent): Activity {
  const phase: RunPhase = event.type === 'approval' ? 'paused'
    : event.type === 'done' ? 'done' : event.type === 'error' ? 'error' : 'running';
  return { runId: event.runId, phase, events: [...state.events, event].slice(-200) };
}

/** Tool IDs, rather than names or run IDs, connect results across approval resumes. */
export function toolsWithResults(calls: ToolCall[], events: ThreadEvent[]): ToolCall[] {
  return calls.map(call => {
    if (call.result) return call;
    const calledAt = events.findLastIndex(event => 'toolCallId' in event && event.toolCallId === call.id && event.type !== 'tool_result');
    const result = events.findLast((event, index) => index > calledAt && event.type === 'tool_result' && event.toolCallId === call.id);
    return result?.type === 'tool_result' ? { ...call, result: { output: result.output, truncated: result.truncated } } : call;
  });
}
