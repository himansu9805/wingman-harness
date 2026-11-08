import { DelegationBusyError } from "./types";
/** FIFO runtime-wide permits. Tool-enabled workers take an exclusive permit. */
export class WorkerSlots {
  private readers = 0;
  private exclusive = false;
  private readonly queue: {
    exclusive: boolean;
    signal: AbortSignal;
    grant(release: () => void): void;
    abort(): void;
  }[] = [];
  constructor(private readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16)
      throw new Error("Worker concurrency must be between 1 and 16");
  }
  acquire(exclusive: boolean, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.queue.length >= 128) throw new DelegationBusyError("Delegated worker queue is full");
    return new Promise((resolve, reject) => {
      const entry = {
        exclusive,
        signal,
        grant: resolve,
        abort: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    while (this.queue.length && !this.exclusive && this.readers < this.limit) {
      const next = this.queue[0]!;
      if (next.exclusive && this.readers) return;
      this.queue.shift();
      next.signal.removeEventListener("abort", next.abort);
      if (next.exclusive) this.exclusive = true;
      else this.readers++;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        if (next.exclusive) this.exclusive = false;
        else this.readers--;
        this.drain();
      });
    }
  }
}
