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
