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
} from "@wingman/core/turns";
import type { Agent } from "@wingman/core";
import { AGENT_RUNTIME, type AgentRuntime } from "./agent.runtime";
import {
  THREAD_REPOSITORY,
  type ThreadRepository,
  type ThreadRecord,
} from "../threads/thread.repository";
import { decodeCursor, encodeCursor } from "../threads/cursors";
import { HistoryCursor, ListCursor } from "../threads/schemas";

/** Owns the agent and serializes mutations of each API-managed thread. */
@Injectable()
export class AgentService implements OnModuleInit, OnApplicationShutdown {
  private agent!: Agent;
  private readonly busy = new Set<string>();

  constructor(
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
    @Inject(THREAD_REPOSITORY) private readonly threads: ThreadRepository,
  ) {}

  async onModuleInit() {
    try {
      await this.threads.init();
      this.agent = await this.runtime.create();
    } catch (error) {
      await this.threads.close();
      throw error;
    }
  }

  async onApplicationShutdown() {
    try {
      await this.runtime.close();
    } finally {
      await this.threads.close();
    }
  }

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

  send(threadId: string, message: string, options: TurnOptions) {
    return this.exclusive(threadId, async () => {
      await this.requireThread(threadId);
      await this.threads.touch(threadId, message);
      try {
        await declinePending(this.agent, threadId, options);
        return await startTurn(this.agent, message, threadId, options);
      } finally {
        await this.threads.touch(threadId);
      }
    });
  }

  resume(threadId: string, answers: Record<string, boolean>, options: TurnOptions) {
    return this.exclusive(threadId, async () => {
      await this.requireThread(threadId);
      const pending = await getPendingApprovals(this.agent, threadId);
      const ids = new Set(pending.map((p) => p.id));
      const given = Object.keys(answers);
      if (ids.size === 0) {
        throw new ConflictException("Nothing is waiting for approval");
      }
      if (given.length !== ids.size || !given.every((id) => ids.has(id))) {
        throw new BadRequestException("Answer every pending approval by id");
      }
      try {
        return await resumeTurn(this.agent, answers, threadId, options);
      } finally {
        await this.threads.touch(threadId);
      }
    });
  }

  async pending(threadId: string) {
    await this.requireThread(threadId);
    return getPendingApprovals(this.agent, threadId);
  }

  /** A deleting marker survives partial failure and lets DELETE safely retry. */
  delete(threadId: string) {
    return this.exclusive(threadId, async () => {
      if (!await this.threads.get(threadId)) return;
      await this.threads.markDeleting(threadId);
      await deleteThreadState(this.agent, threadId);
      await this.threads.delete(threadId);
    });
  }

  private async requireThread(threadId: string): Promise<ThreadRecord> {
    const thread = await this.threads.get(threadId);
    if (!thread) {
      throw new NotFoundException("Thread not found; create it with POST /threads");
    }
    if (thread.deleting) {
      throw new ConflictException("Thread deletion is incomplete; retry DELETE");
    }
    return thread;
  }

  private async exclusive<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(threadId)) {
      throw new ConflictException("A turn is already running on this thread");
    }
    this.busy.add(threadId);
    try {
      return await run();
    } finally {
      this.busy.delete(threadId);
    }
  }
}
