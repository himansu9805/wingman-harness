import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import {
  Agent,
  declinePending,
  getPendingApprovals,
  resumeTurn,
  shutdown,
  startTurn,
  type PendingApproval,
  type TurnOptions,
  type TurnResult,
} from "@wingman/core";

/** Owns the agent and runs at most one turn per thread at a time. */
@Injectable()
export class AgentService implements OnModuleInit, OnApplicationShutdown {
  private agent!: Agent;
  private readonly busy = new Set<string>();

  async onModuleInit() {
    this.agent = await Agent.create();
  }

  async onApplicationShutdown() {
    await shutdown();
  }

  /**
   * Starts a turn from a user message. A thread still paused on an approval
   * from an abandoned turn gets that approval declined first.
   */
  send(threadId: string, message: string, options: TurnOptions) {
    return this.exclusive(threadId, async () => {
      await declinePending(this.agent, threadId, options);
      return startTurn(this.agent, message, threadId, options);
    });
  }

  /** Resumes a paused turn. Every pending approval needs exactly one answer. */
  resume(
    threadId: string,
    answers: Record<string, boolean>,
    options: TurnOptions,
  ) {
    return this.exclusive(threadId, async () => {
      const pending = await this.pending(threadId);
      const ids = new Set(pending.map((p) => p.id));
      const given = Object.keys(answers);
      if (ids.size === 0) {
        throw new ConflictException("Nothing is waiting for approval");
      }
      if (given.length !== ids.size || !given.every((id) => ids.has(id))) {
        throw new BadRequestException("Answer every pending approval by id");
      }
      return resumeTurn(this.agent, answers, threadId, options);
    });
  }

  pending(threadId: string): Promise<PendingApproval[]> {
    return getPendingApprovals(this.agent, threadId);
  }

  private async exclusive(
    threadId: string,
    run: () => Promise<TurnResult>,
  ): Promise<TurnResult> {
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
