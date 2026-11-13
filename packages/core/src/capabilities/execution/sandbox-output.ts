/** Bounded process-local command output for read-only sandbox observers. */
export class SandboxOutput {
  private readonly buffers = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(text: string) => void>>();

  publish(threadId: string, text: string): void {
    if (!text) return;
    const previous = this.buffers.get(threadId) ?? "";
    this.buffers.delete(threadId);
    this.buffers.set(threadId, (previous + text).slice(-65_536));
    if (this.buffers.size > 200) this.buffers.delete(this.buffers.keys().next().value!);
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(text);
      } catch {
        this.listeners.get(threadId)?.delete(listener);
      }
    }
  }

  subscribe(
    threadId: string,
    listener: (text: string) => void,
  ): { snapshot: string; unsubscribe(): void } {
    const listeners = this.listeners.get(threadId) ?? new Set<(text: string) => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return {
      snapshot: this.buffers.get(threadId) ?? "",
      unsubscribe: () => {
        listeners.delete(listener);
        if (!listeners.size) this.listeners.delete(threadId);
      },
    };
  }

  clear(threadId: string): void {
    this.buffers.delete(threadId);
  }
}
