import type { Response } from "express";

/** Returns a writer for Server-Sent Events, opening the stream on first use. */
export function sseWriter(res: Response) {
  return (event: string, data: unknown) => {
    if (!res.headersSent) {
      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
