import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { AgentService } from "../agent/agent.service";
import { parse, ThreadId } from "../threads/schemas";
import { writeSse } from "../threads/sse";

/** Exposes only Wingman-owned sandbox metadata and read-only command output. */
@Controller("sandboxes")
export class SandboxesController {
  constructor(private readonly agent: AgentService) {}

  @Get()
  async list() {
    const monitor = this.agent.sandboxMonitor;
    return { enabled: Boolean(monitor), sandboxes: monitor ? await monitor.list() : [] };
  }

  @Get(":threadId/output")
  async output(@Param("threadId") rawId: string, @Res() res: Response) {
    const id = parse(ThreadId, rawId);
    const monitor = this.agent.sandboxMonitor;
    if (!monitor) throw new NotFoundException("Sandbox monitoring is unavailable");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.agent.shutdownSignal]);
    const queue: string[] = [];
    let queued = 0;
    let started = false;
    let pumping = false;
    const close = () => {
      controller.abort();
      res.end();
    };
    const pump = async () => {
      if (pumping || !started) return;
      pumping = true;
      try {
        while (queue.length && !signal.aborted) {
          const text = queue.shift()!;
          queued -= text.length;
          await writeSse(res, `event: output\ndata: ${JSON.stringify({ text })}\n\n`, signal);
        }
      } catch {
        close();
      } finally {
        pumping = false;
      }
    };
    const enqueue = (text: string) => {
      if (signal.aborted) return;
      queued += text.length;
      if (queued > 262_144) {
        close();
        return;
      }
      queue.push(text);
      void pump();
    };
    let subscription: Awaited<ReturnType<typeof monitor.subscribe>>;
    try {
      subscription = await monitor.subscribe(id, enqueue);
    } catch {
      throw new NotFoundException("Sandbox not found");
    }
    res.once("close", close);
    signal.addEventListener(
      "abort",
      () => {
        subscription.unsubscribe();
        res.end();
      },
      { once: true },
    );
    if (signal.aborted || res.destroyed) {
      subscription.unsubscribe();
      res.end();
      return;
    }
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    queue.unshift(subscription.snapshot);
    queued += subscription.snapshot.length;
    started = true;
    void pump();
    const heartbeat = setInterval(() => {
      if (!signal.aborted) res.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    signal.addEventListener("abort", () => clearInterval(heartbeat), { once: true });
  }
}
