import { Inject, Injectable, Logger } from "@nestjs/common";
import { TITLE_GENERATOR, type TitleGenerator } from "./title-generator";
import { THREAD_EVENTS, type ThreadEventsRepository } from "./thread-events.repository";

export const TITLE_TIMEOUT_MS = Symbol("TITLE_TIMEOUT_MS");

/** Validate generated text independently of the model; catalogue values remain bounded plain text. */
export function normalizeTitle(value: string): string | null {
  const text = value.trim();
  if (!text || /[\r\n]/.test(text) || text.includes("```")) return null;
  return Array.from(text).slice(0, 60).join("");
}

/** Optional background work: never holds a turn lock, and every job has a persisted claim. */
@Injectable()
export class ThreadTitles {
  private readonly logger = new Logger(ThreadTitles.name);
  private readonly jobs = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  private stopping = false;

  constructor(
    @Inject(TITLE_GENERATOR) private readonly generator: TitleGenerator,
    @Inject(THREAD_EVENTS) private readonly events: ThreadEventsRepository,
    @Inject(TITLE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  start(threadId: string, runId: string, claimId: string, query: string): void {
    if (this.stopping || this.jobs.has(threadId)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const completion = this.generate(threadId, runId, claimId, query, signal)
      .catch(() => {
        if (!controller.signal.aborted)
          this.logger.warn(`Title generation unavailable for thread ${threadId}; keeping fallback`);
      })
      .finally(() => this.jobs.delete(threadId));
    this.jobs.set(threadId, { controller, completion });
  }

  private async generate(
    threadId: string,
    runId: string,
    claimId: string,
    query: string,
    signal: AbortSignal,
  ) {
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([this.generator.generate(query, signal), interrupted]);
      signal.throwIfAborted();
      const title = normalizeTitle(result);
      if (!title) return;
      await this.events.completeTitle(threadId, claimId, runId, title);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async cancel(threadId: string): Promise<void> {
    const job = this.jobs.get(threadId);
    job?.controller.abort();
    await job?.completion;
  }

  async close(): Promise<void> {
    this.stopping = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.completion));
  }
}
