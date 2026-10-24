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
import type { Agent } from "@wingman/core";
import { AGENT_RUNTIME, type AgentRuntime } from "./agent.runtime";
import {
  THREAD_REPOSITORY,
  type ThreadRepository,
  type ThreadRecord,
} from "../threads/thread.repository";
import { decodeCursor, encodeCursor } from "../threads/cursors";
import { TurnRunner } from "./turn-runner.service";
import { THREAD_EVENTS, type ThreadEventsRepository } from "../threads/thread-events.repository";
import { HistoryCursor, ListCursor } from "../threads/schemas";

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
    } catch (error) {
      await this.events.close();
      await this.threads.close();
      throw error;
    }
  }

  async beforeApplicationShutdown() {
    await this.runner.close();
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
      threads: page.items.map(({ id, title, createdAt, updatedAt }) => ({
        id, title, createdAt, updatedAt,
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
      return async (runId, signal) => { await this.execute(threadId, runId, signal, options => resumeTurn(this.agent, answers, threadId, options)); };
    });
    return { runId: accepted.runId };
  }

  private async execute(threadId: string, runId: string, signal: AbortSignal, run: (options: TurnOptions) => Promise<TurnResult>): Promise<TurnResult> {
    try {
      const result = await run({ signal, onEvent: async payload => { await this.events.append(threadId, runId, payload); } });
      await this.threads.touch(threadId);
      await this.events.append(threadId, runId, result.kind === "paused"
        ? { type: "approval", approvals: result.interrupts.map(it => ({ id: it.id!, command: it.value!.command })) }
        : { type: "done", text: result.text });
      return result;
    } catch (error) {
      await this.events.append(threadId, runId, { type: "error", message: signal.aborted ? "Server stopped the turn" : "Turn failed; check server logs" });
      throw error;
    }
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
