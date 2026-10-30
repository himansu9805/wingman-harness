import { performance } from "node:perf_hooks";
import { addUsage, emptyUsage, startMetadata, finishMetadata, type RunMetadata } from "./run-metadata";
import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  Injectable,
  Inject,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import {
  declinePending,
  getPendingApprovals,
  getThreadMessages,
  deleteThreadState,
  resumeTurn,
  startTurn,
  type TurnOptions,
  type TurnResult,
} from "@wingman/core/turns";
import type { Agent, ScheduledEvent, TaskRun } from "@wingman/core";
import { AGENT_RUNTIME, type AgentRuntime } from "./agent.runtime";
import {
  THREAD_REPOSITORY,
  type ThreadRepository,
  type ThreadRecord,
} from "../threads/thread.repository";
import { decodeCursor, encodeCursor } from "../threads/cursors";
import { TurnRunner } from "./turn-runner.service";
import { THREAD_EVENTS, type ThreadEventsRepository } from "../threads/thread-events.repository";
import { HistoryCursor, ListCursor, RunCursor } from "../threads/schemas";

/** Owns the agent and serializes mutations of each API-managed thread. */
@Injectable()
export class AgentService implements OnModuleInit, OnApplicationShutdown {
  private agent!: Agent;


  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(THREAD_REPOSITORY) private readonly threads: ThreadRepository,
    @Inject(THREAD_EVENTS) readonly events: ThreadEventsRepository,
    private readonly runner: TurnRunner,
  ) {}

  async onModuleInit() {
    try {
      await this.threads.init();
      await this.events.init();
      this.agent = await this.runtime.create();
      await this.runtime.startScheduler(event => this.dispatchScheduled(event));
    } catch (error) {
      try { await this.runtime.close(); } finally {
        try { await this.events.close(); } finally { await this.threads.close(); }
      }
      throw error;
    }
  }

  async beforeApplicationShutdown() {
    const draining = this.runner.close();
    await this.runtime.stopScheduler();
    await draining;
  }

  async onApplicationShutdown() {
    try {
      await this.runtime.close();
    } finally {
      try { await this.events.close(); } finally { await this.threads.close(); }
    }
  }

  get shutdownSignal(): AbortSignal { return this.runner.shutdownSignal; }

  async create() {
    const id = randomUUID();
    await this.threads.create(id);
    return { id };
  }

  async list(limit: number, cursor?: string) {
    const position = cursor ? decodeCursor(ListCursor, cursor) : undefined;
    const page = await this.threads.list({ limit, cursor: position });
    const last = page.items.at(-1);
    return {
      threads: page.items.map(({ id, title, createdAt, updatedAt, source, scheduled }) => ({
        id, title, createdAt, updatedAt, source, scheduled,
      })),
      nextCursor: page.hasMore && last
        ? encodeCursor({ id: last.id, updatedAt: last.updatedAt })
        : null,
    };
  }

  async messages(threadId: string, limit: number, cursor?: string) {
    await this.requireThread(threadId);
    const position = cursor ? decodeCursor(HistoryCursor, cursor) : undefined;
    if (position && position.threadId !== threadId) {
      throw new BadRequestException("Cursor belongs to another thread");
    }
    const history = await getThreadMessages(
      this.agent, threadId, position?.checkpointId,
    );
    if (position && history.checkpointId !== position.checkpointId) {
      throw new BadRequestException("History snapshot is no longer available");
    }
    const end = position?.end ?? history.messages.length;
    if (end > history.messages.length) {
      throw new BadRequestException("Invalid history cursor");
    }
    const start = Math.max(0, end - limit);
    return {
      messages: history.messages.slice(start, end),
      nextCursor: start > 0 && history.checkpointId
        ? encodeCursor({ threadId, checkpointId: history.checkpointId, end: start })
        : null,
    };
  }

  async send(threadId: string, message: string) {
    const accepted = await this.runner.accept(threadId, async () => {
      await this.requireThread(threadId);
      await this.threads.touch(threadId, message);
      return async (runId, signal) => { await this.execute(threadId, runId, signal, async options => {
        await declinePending(this.agent, threadId, options);
        return startTurn(this.agent, message, threadId, options);
      }); };
    });
    return { runId: accepted.runId };
  }

  async resume(threadId: string, answers: Record<string, boolean>) {
    const accepted = await this.runner.accept(threadId, async () => {
      await this.requireThread(threadId);
      const pending = await getPendingApprovals(this.agent, threadId);
      const ids = new Set(pending.map(p => p.id));
      const given = Object.keys(answers);
      if (!ids.size) throw new ConflictException("Nothing is waiting for approval");
      if (given.length !== ids.size || !given.every(id => ids.has(id)))
        throw new BadRequestException("Answer every pending approval by id");
      return async (runId, signal) => { await this.execute(threadId, runId, signal, options => resumeTurn(this.agent, answers, threadId, options), "resume"); };
    });
    return { runId: accepted.runId };
  }

  async runs(threadId: string, limit: number, cursor?: string) {
    await this.requireThread(threadId);
    const position = cursor ? decodeCursor(RunCursor, cursor) : undefined;
    if (position && position.threadId !== threadId) throw new BadRequestException("Cursor belongs to another thread");
    const rows = await this.events.listRuns(threadId, position?.before, limit);
    const last = rows.at(-1);
    const more = last && (await this.events.listRuns(threadId, last.sequence, 1)).length > 0;
    return { runs: rows.flatMap(row => row.payload.type === "run" ? [row.payload.metadata] : []),
      nextCursor: more && last ? encodeCursor({ threadId, before: last.sequence }) : null };
  }

  private async execute(threadId: string, runId: string, signal: AbortSignal, run: (options: TurnOptions) => Promise<TurnResult>, origin: RunMetadata["origin"] = "message"): Promise<TurnResult> {
    const previousRow = (await this.events.listRuns(threadId, undefined, 1))[0];
    const previous = previousRow?.payload.type === "run" ? previousRow.payload.metadata : undefined;
    const now = new Date();
    // Sending a new prompt abandons a previous approval instead of resuming it.
    if (origin !== "resume" && previous?.status === "paused") {
      const closed = { ...previous, status: "interrupted" as const,
        turn: { ...previous.turn, completedAt: now.toISOString(),
          elapsedMs: Math.max(0, now.getTime() - Date.parse(previous.turn.startedAt)),
          approvalWaitMs: previous.turn.approvalWaitMs + Math.max(0, now.getTime() - Date.parse(previous.finishedAt!)) } };
      await this.events.append(threadId, previous.runId, { type: "run", metadata: closed });
    }
    const metadata = startMetadata(runId, origin, now, previous);
    const started = performance.now();
    let usage = emptyUsage();
    await this.events.append(threadId, runId, { type: "run", metadata });
    const finish = async (status: Parameters<typeof finishMetadata>[1]) => {
      const finished = finishMetadata(metadata, status, new Date(), Math.max(0, Math.round(performance.now() - started)), usage);
      await this.events.append(threadId, runId, { type: "run", metadata: finished });
    };
    try {
      const result = await run({ signal, schedulerThreadId: threadId,
        onModelUsage: async counts => { usage = addUsage(usage, counts); await finish("running"); },
        onEvent: async payload => { await this.events.append(threadId, runId, payload); } });
      await this.threads.touch(threadId);
      await finish(result.kind === "paused" ? "paused" : "completed");
      await this.events.append(threadId, runId, result.kind === "paused"
        ? { type: "approval", approvals: result.interrupts.map(it => ({ id: it.id!, command: it.value!.command })) }
        : { type: "done", text: result.text });
      return result;
    } catch (error) {
      await finish(signal.aborted ? "interrupted" : "failed");
      await this.events.append(threadId, runId, { type: "error", message: signal.aborted ? "Server stopped the turn" : "Turn failed; check server logs" });
      throw error;
    }
  }

  /** Keep Agenda's lock until execution settles; never consume an existing approval. */
  async dispatchScheduled(event: ScheduledEvent): Promise<void | { retryAt: Date }> {
    const threadId = randomUUID();
    const startedAt = new Date();
    let result: TurnResult | undefined;
    let acceptedRun = false;
    try {
      const accepted = await this.runner.accept(threadId, async () => {
        if (!event.standalone) await this.requireThread(event.threadId);
        return async (runId, signal) => {
          await this.threads.create(threadId, { taskId: event.jobId, taskRunId: runId,
            originThreadId: event.standalone ? null : event.threadId });
          await this.threads.touch(threadId, event.prompt);
          await this.events.append(threadId, runId, { type: "scheduled", jobId: event.jobId, prompt: event.prompt });
          result = await this.execute(threadId, runId, signal, options => startTurn(this.agent,
            `This task was scheduled earlier and is due now: ${event.prompt}\nCarry it out now. Your reply is the result delivered to the user. Do not schedule it again. Commands requiring approval must wait for the user's decision.`, threadId, options), "scheduled");
        };
      });
      acceptedRun = true;
      await accepted.completion;
    } catch (error) {
      if (!acceptedRun && error instanceof ConflictException) return { retryAt: new Date(Date.now() + 30_000) };
      await this.runtime.recordRun({ jobId: event.jobId, prompt: event.prompt, threadId, status: this.shutdownSignal.aborted ? "interrupted" : "failed", error: error instanceof Error ? error.message : String(error), startedAt, finishedAt: new Date() });
      throw error;
    }
    const run: TaskRun = { jobId: event.jobId, prompt: event.prompt, threadId, status: result?.kind === "paused" ? "paused" : "success", ...(result?.kind === "done" ? { output: result.text } : {}), startedAt, finishedAt: new Date() };
    await this.runtime.recordRun(run);
  }

  async pending(threadId: string) {
    await this.requireThread(threadId);
    return getPendingApprovals(this.agent, threadId);
  }

  /** A deleting marker survives partial failure and lets DELETE safely retry. */
  delete(threadId: string) {
    return this.runner.exclusive(threadId, async () => {
      if (!await this.threads.get(threadId)) return;
      await this.threads.markDeleting(threadId);
      await deleteThreadState(this.agent, threadId);
      await this.events.delete(threadId);
      await this.threads.delete(threadId);
    });
  }

  async requireThread(threadId: string): Promise<ThreadRecord> {
    const thread = await this.threads.get(threadId);
    if (!thread) {
      throw new NotFoundException("Thread not found; create it with POST /threads");
    }
    if (thread.deleting) {
      throw new ConflictException("Thread deletion is incomplete; retry DELETE");
    }
    return thread;
  }

}
