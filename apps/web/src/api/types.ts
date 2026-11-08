import type { RunMetadata } from './run-metadata';

export interface Connection { url: string }
export interface Thread { hasScheduledTasks: boolean; source?: "chat" | "scheduled"; scheduled?: { taskId: string; taskRunId: string; originThreadId: string | null } | null; id: string; title: string; createdAt: string; updatedAt: string }
export interface Approval { id: string; command: string; execution: { agentId: string; taskId: string | null; toolCallId: string } }
export interface ToolCall {
  id: string; name: string; args: Record<string, unknown>;
  result?: { output: string; truncated: boolean };
}
export interface Message { id: string; role: 'user' | 'assistant'; text: string; toolCalls?: ToolCall[] }
export interface History { messages: Message[]; nextCursor: string | null }
export interface Catalogue { threads: Thread[]; nextCursor: string | null }
export type ThreadEvent = { runId: string; createdAt?: string } & (
  | { type: 'delegation'; phase: 'started' | 'waiting_approval' | 'resumed' | 'cancelled' | 'recovery_required' | 'completed' | 'failed' | 'interrupted' | 'reused' | 'blocked'; taskId: string; agentId: string; conversationId: string; parentExecutionId: string; parentToolCallId: string }
  | { type: 'agent_activity'; taskId: string; agentId: string; event: { type: 'tool_call' | 'memory'; name: string; args: unknown; toolCallId?: string } | { type: 'skill'; name: string; toolCallId?: string } | { type: 'tool_result'; name: string; toolCallId: string; output: string; truncated: boolean } }
  | { type: 'run'; metadata: RunMetadata }
  | { type: 'route'; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: 'tool_call' | 'memory'; name: string; args: Record<string, unknown>; toolCallId?: string }
  | { type: 'skill'; name: string; toolCallId?: string }
  | { type: 'tool_result'; name: string; toolCallId: string; output: string; truncated: boolean }
  | { type: 'approval'; approvals: Approval[] }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'scheduled'; jobId: string; prompt: string }
);
