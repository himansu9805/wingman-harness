import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Query,
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
