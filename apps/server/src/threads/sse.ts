import type { Response } from "express";
import type { StoredThreadEvent } from "./thread-events.repository";

export function eventFrame(row: StoredThreadEvent): string {
  return `id: ${row.threadId}:${row.sequence}\nevent: ${row.payload.type}\ndata: ${JSON.stringify({ ...row.payload, runId: row.runId })}\n\n`;
}

/** Await backpressure without retaining an unbounded queue for a slow client. */
export async function writeSse(res: Response, frame: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (res.destroyed) throw new Error("Event stream closed");
  if (res.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      res.off("drain", drain); res.off("close", closed); res.off("error", failed);
      signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const drain = () => finish();
    const closed = () => finish(new Error("Event stream closed"));
    const failed = (error: Error) => finish(error);
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Event stream client is too slow")), 10_000);
    res.once("drain", drain); res.once("close", closed); res.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (res.destroyed) closed();
  });
}
