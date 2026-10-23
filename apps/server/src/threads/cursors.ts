import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/** Opaque pagination token; it contains no credentials or message content. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(schema: z.ZodType<T>, cursor: string): T {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("Invalid encoding");
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}
