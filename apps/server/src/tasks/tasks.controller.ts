import { BadRequestException, ConflictException, Controller, Delete, Get, HttpCode, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { AGENT_RUNTIME, type AgentRuntime } from "../agent/agent.runtime";
import { ListQuery, parse } from "../threads/schemas";
import { decodeCursor, encodeCursor } from "../threads/cursors";

const TaskId = z.uuid();
const TaskCursor = z.object({ kind: z.literal("tasks"), before: TaskId }).strict();
const RunCursor = z.object({ kind: z.literal("task-runs"), jobId: TaskId.nullable(),
  before: z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n) }).strict();
const RunsQuery = ListQuery.extend({ jobId: TaskId.optional() });

@Controller("tasks")
export class TasksController {
  constructor(@Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime) {}

  @Get()
  async list(@Query() query: unknown) {
    const { limit, cursor } = parse(ListQuery, query);
    const position = cursor ? decodeCursor(TaskCursor, cursor) : undefined;
    const [schedulerEnabled, page] = await Promise.all([
      this.runtime.schedulerEnabled(), this.runtime.listTasks(limit, position?.before),
    ]);
    return { schedulerEnabled, tasks: page.items,
      nextCursor: page.nextBefore ? encodeCursor({ kind: "tasks", before: page.nextBefore }) : null };
  }

  /** Cancellation removes future scheduling; locked tasks must finish first. */
  @Delete(":taskId")
  @HttpCode(204)
  async cancel(@Param("taskId") taskId: string) {
    const id = parse(TaskId, taskId);
    try { await this.runtime.cancelTask(id); }
    catch (error) {
      if (error instanceof Error && error.name === "TaskBusyError") throw new ConflictException(error.message);
      throw error;
    }
  }

  /** History is independent of schedule existence, including cancelled jobs. */
  @Get("runs")
  async runs(@Query() query: unknown) {
    const { limit, cursor, jobId } = parse(RunsQuery, query);
    const position = cursor ? decodeCursor(RunCursor, cursor) : undefined;
    if (position && position.jobId !== (jobId ?? null)) throw new BadRequestException("Cursor belongs to another task filter");
    const page = await this.runtime.taskRuns(limit, jobId, position?.before);
    return { runs: page.items, nextCursor: page.nextBefore
      ? encodeCursor({ kind: "task-runs", jobId: jobId ?? null, before: page.nextBefore }) : null };
  }
}
