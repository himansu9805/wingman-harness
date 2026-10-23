import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res,
} from "@nestjs/common";
import type { Response } from "express";
import type { TurnOptions, TurnResult } from "@wingman/core";
import { AgentService } from "../agent/agent.service";
import { sseWriter } from "./sse";
import {
  parse, ResumeBody, SendBody, ThreadId, ListQuery, HistoryQuery,
} from "./schemas";

@Controller("threads")
export class ThreadsController {
  constructor(private readonly agent: AgentService) {}

  @Post()
  create() {
    return this.agent.create();
  }

  @Get()
  list(@Query() query: unknown) {
    const { limit, cursor } = parse(ListQuery, query);
    return this.agent.list(limit, cursor);
  }

  @Get(":threadId/messages")
  messages(@Param("threadId") threadId: string, @Query() query: unknown) {
    const { limit, cursor } = parse(HistoryQuery, query);
    return this.agent.messages(parse(ThreadId, threadId), limit, cursor);
  }

  @Delete(":threadId")
  @HttpCode(204)
  async delete(@Param("threadId") threadId: string) {
    await this.agent.delete(parse(ThreadId, threadId));
  }

  /** Streams a turn: progress events, then `approval` or `done`. */
  @Post(":threadId/messages")
  async send(
    @Param("threadId") threadId: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const id = parse(ThreadId, threadId);
    const { message } = parse(SendBody, body);
    await this.stream(res, (options) => this.agent.send(id, message, options));
  }

  /** Answers pending approvals and streams the rest of the turn. */
  @Post(":threadId/resume")
  async resume(
    @Param("threadId") threadId: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const id = parse(ThreadId, threadId);
    const { answers } = parse(ResumeBody, body);
    await this.stream(res, (options) =>
      this.agent.resume(id, answers, options),
    );
  }

  /** What the thread is waiting on, so the UI can recover after a reload. */
  @Get(":threadId/pending")
  pending(@Param("threadId") threadId: string) {
    return this.agent.pending(parse(ThreadId, threadId));
  }

  /**
   * Runs a turn and streams it. Closing the connection aborts the turn; if it
   * was paused, the next message declines the pending approval.
   */
  private async stream(
    res: Response,
    run: (options: TurnOptions) => Promise<TurnResult>,
  ) {
    const send = sseWriter(res);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let result: TurnResult;
    try {
      result = await run({
        signal: controller.signal,
        onEvent: (event) => send(event.type, event),
      });
    } catch (err) {
      if (!res.headersSent) throw err; // nothing streamed yet: normal HTTP error
      if (!controller.signal.aborted)
        send("error", { message: (err as Error).message });
      res.end();
      return;
    }

    if (result.kind === "paused") {
      send("approval", {
        approvals: result.interrupts.map((it) => ({
          id: it.id!,
          command: it.value!.command,
        })),
      });
    } else {
      send("done", { text: result.text });
    }
    res.end();
  }
}
