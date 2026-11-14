import type { SandboxOutputCursor, SandboxOutputEvent } from "./sandbox-output";

/** Metadata for a Wingman-owned conversation sandbox. */
export interface SandboxInfo {
  threadId: string;
  name: string;
  containerId: string | null;
  status: "running" | "stopped" | "missing" | "expired" | "provisioning" | "unavailable";
  sessionStatus: "ready" | "running" | "needs_reset" | "inactive" | "remote" | "unavailable";
  createdAt: string | null;
  lastUsedAt: string;
  expiredAt: string | null;
}

/** Manage conversation sandboxes and observe their recent process-local output. */
export interface SandboxMonitor {
  list(): Promise<SandboxInfo[]>;
  subscribeEvents(
    threadId: string,
    after: SandboxOutputCursor | null,
    listener: (event: SandboxOutputEvent) => void,
  ): Promise<{
    cursor: SandboxOutputCursor;
    events: SandboxOutputEvent[];
    gap: boolean;
    unsubscribe(): void;
  }>;
  resize(threadId: string, cols: number, rows: number): Promise<boolean>;
  stop(threadId: string): Promise<boolean>;
  release(threadId: string): Promise<void>;
}
