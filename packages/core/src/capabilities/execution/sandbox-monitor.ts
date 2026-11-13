/** Metadata for a Wingman-owned conversation sandbox. */
export interface SandboxInfo {
  threadId: string;
  containerId: string | null;
  status: "running" | "stopped" | "missing" | "expired" | "provisioning" | "unavailable";
  createdAt: string | null;
  lastUsedAt: string;
  expiredAt: string | null;
}

/** Read-only access to sandbox metadata and recent process-local command output. */
export interface SandboxMonitor {
  list(): Promise<SandboxInfo[]>;
  subscribe(
    threadId: string,
    listener: (text: string) => void,
  ): Promise<{ snapshot: string; unsubscribe(): void }>;
}
