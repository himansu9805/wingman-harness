import { randomUUID } from "node:crypto";
import { ConflictException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

interface ActiveRun {
  runId: string;
  controller: AbortController;
  completion: Promise<void>;
}

/** A single server process owns thread mutations, independently of clients. */
@Injectable()
export class TurnRunner {
  private readonly logger = new Logger(TurnRunner.name);
  private readonly busy = new Set<string>();
  private readonly active = new Map<string, ActiveRun>();
  private stopping = false;
  private readonly shutdown = new AbortController();
  get shutdownSignal(): AbortSignal { return this.shutdown.signal; }

  private reserve(threadId: string) {
    if (this.stopping) throw new ServiceUnavailableException("Server is shutting down");
    if (this.busy.has(threadId)) throw new ConflictException("A turn is already running on this thread");
    this.busy.add(threadId);
  }

  async accept(threadId: string, prepare: () => Promise<(runId: string, signal: AbortSignal) => Promise<void>>) {
    this.reserve(threadId);
    const runId = randomUUID();
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const active = { runId, controller, completion };
    this.active.set(threadId, active);
    const release = () => { this.active.delete(threadId); this.busy.delete(threadId); };
    try {
      const run = await prepare();
      controller.signal.throwIfAborted();
      void Promise.resolve().then(() => run(runId, controller.signal)).then(
        () => { release(); resolve(); },
        error => { release(); reject(error); },
      );
      // Attach a handler even when no scheduler/client awaits completion.
      completion.catch(error => this.logger.error(`Run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`));
      return { runId, completion };
    } catch (error) {
      release(); resolve(); throw error;
    }
  }

  async exclusive<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    this.reserve(threadId);
    try { return await run(); } finally { this.busy.delete(threadId); }
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort(new Error("Server is shutting down"));
    await Promise.allSettled(runs.map(run => run.completion));
  }
}
