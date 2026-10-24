import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export const ThreadId = z.string().regex(/^[\w-]{1,64}$/);
export const SendBody = z.object({
  message: z.string().trim().min(1).max(20_000),
});
export const ResumeBody = z.object({
  answers: z.record(z.string(), z.boolean()),
});

/** Parses input, turning validation failures into a 400. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

const Cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: Cursor.optional(),
});
export const HistoryQuery = ListQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ListCursor = z.object({
  id: ThreadId,
  updatedAt: z.iso.datetime(),
}).strict();
export const HistoryCursor = z.object({
  threadId: ThreadId,
  checkpointId: z.string().min(1).max(200),
  end: z.number().int().nonnegative(),
}).strict();

export const RunCursor = z.object({ threadId: ThreadId, before: z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n) }).strict();
