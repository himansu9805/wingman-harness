import { setTimeout as delay } from "node:timers/promises";
import type { Response } from "express";
import { eventFrame, writeSse } from "./sse";
import { validateSequence } from "./thread-events.repository";
import {
  BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Res,
} from "@nestjs/common";
import { AgentService } from "../agent/agent.service";
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

  /** Replays the journal and polls for new rows without a replay/live handoff gap. */
  @Get(":threadId/events")
  async events(@Param("threadId") rawId: string, @Headers("last-event-id") lastId: string | undefined, @Res() res: Response) {
    const threadId = parse(ThreadId, rawId);
    await this.agent.requireThread(threadId);
    let cursor = "0";
    if (lastId !== undefined) {
      const prefix = `${threadId}:`;
      if (!lastId.startsWith(prefix)) throw new BadRequestException("Event cursor belongs to another thread");
      cursor = lastId.slice(prefix.length);
      try { validateSequence(cursor); } catch { throw new BadRequestException("Invalid event cursor"); }
      if (BigInt(cursor) > BigInt(await this.agent.events.latest(threadId))) throw new BadRequestException("Event cursor is ahead of this thread");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.agent.shutdownSignal]);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    res.once("error", disconnect);
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let heartbeatAt = Date.now();
    try {
      while (!signal.aborted) {
        try { await this.agent.requireThread(threadId); } catch { break; }
        const rows = await this.agent.events.listAfter(threadId, cursor, 100);
        for (const row of rows) {
          await writeSse(res, eventFrame(row), signal);
          cursor = row.sequence;
        }
        if (rows.length === 100) continue;
        if (Date.now() - heartbeatAt >= 15_000) {
          await writeSse(res, ": heartbeat\n\n", signal);
          heartbeatAt = Date.now();
        }
        await delay(100, undefined, { signal });
      }
    } catch {
      // The journal remains replayable after a disconnect or transport failure.
      // End the connection so the client reconnects from its last received ID.
    } finally {
      controller.abort();
      res.off("close", disconnect); res.off("error", disconnect);
      res.end();
    }
  }

  /** Accepts a turn; progress is delivered through the events endpoint. */
  @Post(":threadId/messages")
  @HttpCode(202)
  send(@Param("threadId") threadId: string, @Body() body: unknown) {
    const { message } = parse(SendBody, body);
    return this.agent.send(parse(ThreadId, threadId), message);
  }

  @Post(":threadId/resume")
  @HttpCode(202)
  resume(@Param("threadId") threadId: string, @Body() body: unknown) {
    const { answers } = parse(ResumeBody, body);
    return this.agent.resume(parse(ThreadId, threadId), answers);
  }

  /** What the thread is waiting on, so the UI can recover after a reload. */
  @Get(":threadId/pending")
  pending(@Param("threadId") threadId: string) {
    return this.agent.pending(parse(ThreadId, threadId));
  }

}
