import { randomUUID } from "node:crypto";

export interface SandboxOutputEvent {
  readonly generation: string;
  readonly sequence: number;
  readonly text: string;
  readonly kind:
    | "output"
    | "command.started"
    | "command.completed"
    | "command.uncertain"
    | "session.reset";
  readonly commandId?: string;
  /** The command active when this shared PTY output was observed. */
  readonly observedDuringCommandId?: string;
  readonly exitCode?: number;
}

export interface SandboxOutputCursor {
  readonly generation: string;
  readonly sequence: number;
}

interface OutputBuffer {
  generation: string;
  sequence: number;
  droppedThrough: number;
  size: number;
  events: SandboxOutputEvent[];
}

/** Bounded, process-local sandbox output with resumable sequence cursors. */
export class SandboxOutput {
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly eventListeners = new Map<string, Set<(event: SandboxOutputEvent) => void>>();

  private buffer(threadId: string): OutputBuffer {
    let buffer = this.buffers.get(threadId);
    if (!buffer) {
      buffer = { generation: randomUUID(), sequence: 0, droppedThrough: 0, size: 0, events: [] };
    }
    this.buffers.delete(threadId);
    this.buffers.set(threadId, buffer);
    if (this.buffers.size > 200) this.buffers.delete(this.buffers.keys().next().value!);
    return buffer;
  }

  publish(
    threadId: string,
    text: string,
    details: Pick<
      SandboxOutputEvent,
      "kind" | "commandId" | "observedDuringCommandId" | "exitCode"
    > = { kind: "output" },
  ): void {
    if (!text) return;
    const buffer = this.buffer(threadId);
    const event: SandboxOutputEvent = {
      generation: buffer.generation,
      sequence: ++buffer.sequence,
      text,
      ...details,
    };
    buffer.events.push(event);
    buffer.size += text.length;
    while (buffer.size > 65_536) {
      const oldest = buffer.events[0]!;
      const excess = buffer.size - 65_536;
      buffer.droppedThrough = oldest.sequence;
      if (oldest.text.length <= excess) {
        buffer.events.shift();
        buffer.size -= oldest.text.length;
      } else {
        buffer.events[0] = { ...oldest, text: oldest.text.slice(excess) };
        buffer.size -= excess;
      }
    }
    for (const listener of this.eventListeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {
        this.eventListeners.get(threadId)?.delete(listener);
      }
    }
  }

  /** Attach a listener and return the retained events after a cursor in one synchronous operation. */
  subscribeEvents(
    threadId: string,
    after: SandboxOutputCursor | null,
    listener: (event: SandboxOutputEvent) => void,
  ): {
    cursor: SandboxOutputCursor;
    events: SandboxOutputEvent[];
    gap: boolean;
    unsubscribe(): void;
  } {
    const buffer = this.buffer(threadId);
    const listeners =
      this.eventListeners.get(threadId) ?? new Set<(event: SandboxOutputEvent) => void>();
    listeners.add(listener);
    this.eventListeners.set(threadId, listeners);
    const sameGeneration = after?.generation === buffer.generation;
    const gap =
      after !== null &&
      (!sameGeneration ||
        after.sequence < buffer.droppedThrough ||
        after.sequence > buffer.sequence);
    return {
      cursor: { generation: buffer.generation, sequence: buffer.sequence },
      events: buffer.events.filter(
        (event) => !sameGeneration || gap || event.sequence > after!.sequence,
      ),
      gap,
      unsubscribe: () => {
        listeners.delete(listener);
        if (!listeners.size) this.eventListeners.delete(threadId);
      },
    };
  }

  clear(threadId: string): void {
    this.buffers.delete(threadId);
  }
}
