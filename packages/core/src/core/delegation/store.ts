import { randomUUID } from "node:crypto";
import { DelegatedTaskSchema, type DelegatedTask, type DelegationIdentity, type DelegationRequest, type TaskFinish } from "./types";
import type { ModelUsage } from "../usage";

export interface TaskClaim extends DelegationIdentity {
  request: DelegationRequest;
  requestHash: string;
}

/** One persisted task per user turn; claiming is atomic across concurrent callers. */
export interface DelegationStore {
  init(): Promise<void>;
  /** Atomically insert, or return the one existing task for the same user turn. */
  claim(input: TaskClaim): Promise<{ created: boolean; task: DelegatedTask }>;
  /** Persist the tool-free worker's single model invocation before forwarding usage. */
  recordUsage(taskId: string, usage: ModelUsage): Promise<void>;
  /** Terminal results are immutable: repeated finish calls return the first result. */
  finish(taskId: string, result: TaskFinish): Promise<DelegatedTask>;
  /** Returns at most 100 mappings; cleanup deletes a batch before asking again. */
  listConversation(conversationId: string): Promise<DelegatedTask[]>;
  delete(taskId: string): Promise<void>;
  close(): Promise<void>;
}

/** Creates an internal checkpoint identity; it is never registered as a sidebar chat. */
export function newTask(input: TaskClaim): DelegatedTask {
  const taskId = randomUUID();
  return DelegatedTaskSchema.parse({
    ...input, taskId, checkpointThreadId: `wingman-delegation:${taskId}`,
    status: "running", output: null, truncated: false, error: null, usage: [],
    startedAt: new Date().toISOString(), finishedAt: null,
  });
}

/** Ephemeral implementation used when checkpoints are also in memory and in deterministic tests. */
export class MemoryDelegationStore implements DelegationStore {
  private readonly tasks = new Map<string, DelegatedTask>();
  private closed = false;
  private assertOpen() { if (this.closed) throw new Error("Delegation store is closed"); }
  async init() { this.assertOpen(); }
  async claim(input: TaskClaim) {
    this.assertOpen();
    const existing = [...this.tasks.values()].find(task => task.conversationId === input.conversationId && task.parentExecutionId === input.parentExecutionId);
    if (existing) return { created: false, task: structuredClone(existing) };
    const task = newTask(input);
    this.tasks.set(task.taskId, task);
    return { created: true, task: structuredClone(task) };
  }
  async recordUsage(taskId: string, usage: ModelUsage) {
    this.assertOpen();
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running" || task.usage.length >= 1) throw new Error("Delegated model-call budget exhausted");
    task.usage.push({ ...usage });
  }
  async finish(taskId: string, result: TaskFinish) {
    this.assertOpen();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Delegated task is missing");
    if (task.status === "running") this.tasks.set(taskId, DelegatedTaskSchema.parse({ ...task, ...result }));
    return structuredClone(this.tasks.get(taskId)!);
  }
  async listConversation(conversationId: string) {
    this.assertOpen();
    return [...this.tasks.values()].filter(task => task.conversationId === conversationId).slice(0, 100).map(task => structuredClone(task));
  }
  async delete(taskId: string) { this.assertOpen(); this.tasks.delete(taskId); }
  async close() { this.closed = true; }
}
