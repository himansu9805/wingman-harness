import { randomUUID } from "node:crypto";
import pg from "pg";
import { PtySession } from "./pty-session";
import type { SandboxOutput } from "./sandbox-output";

/** Owns conversation PTYs and their cross-process leases. */
export class SandboxSessions {
  private readonly active = new Map<
    string,
    { containerId: string; session: PtySession; lease: pg.Client }
  >();
  private readonly terminalSizes = new Map<string, { cols: number; rows: number }>();

  constructor(
    private readonly databaseUrl: string,
    private readonly output: SandboxOutput,
  ) {}

  get(threadId: string) {
    return this.active.get(threadId);
  }

  resize(threadId: string, cols: number, rows: number): void {
    this.terminalSizes.set(threadId, { cols, rows });
    const current = this.active.get(threadId);
    if (current && !current.session.isClosed) current.session.resize(cols, rows);
  }

  forgetSize(threadId: string): void {
    this.terminalSizes.delete(threadId);
  }

  async closeAll(): Promise<void> {
    for (const threadId of this.active.keys()) await this.close(threadId);
  }

  /** Acquire exclusive cross-process ownership before starting a conversation shell. */
  async acquire(
    threadId: string,
    containerId: string,
    db: pg.PoolClient,
  ): Promise<{ session: PtySession; reset: boolean }> {
    const current = this.active.get(threadId);
    if (current && current.containerId === containerId && !current.session.isClosed)
      return { session: current.session, reset: false };
    const previous = await db.query<{ shell_session_id: string | null }>(
      "SELECT shell_session_id FROM wingman_docker_sessions WHERE thread_id=$1",
      [threadId],
    );
    const reset = Boolean(current || previous.rows[0]?.shell_session_id);
    if (current) await this.close(threadId);
    const lease = new pg.Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    let session: PtySession | undefined;
    lease.on("error", (error) => {
      console.error("Sandbox session ownership lost", error);
      if (session) void session.close();
    });
    lease.on("end", () => {
      if (session && !session.isClosed) void session.close();
    });
    try {
      await lease.connect();
      const result = await lease.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [`wingman-pty-session:${threadId}`],
      );
      if (!result.rows[0]?.acquired)
        throw new Error("Sandbox shell is owned by another server instance");
      session = new PtySession(containerId, (text, commandId) =>
        this.output.publish(threadId, text, {
          kind: "output",
          ...(commandId && { observedDuringCommandId: commandId }),
        }),
      );
      await session.start();
      if (session.isClosed) throw new Error("PTY session closed during startup");
      const dimensions = this.terminalSizes.get(threadId);
      if (dimensions) session.resize(dimensions.cols, dimensions.rows);
      await db.query("UPDATE wingman_docker_sessions SET shell_session_id=$2 WHERE thread_id=$1", [
        threadId,
        randomUUID(),
      ]);
      this.active.set(threadId, { containerId, session, lease });
      const owned = session;
      void session
        .waitClosed()
        .then(async () => {
          if (this.active.get(threadId)?.session === owned) await this.close(threadId);
        })
        .catch((error: unknown) => console.error("Failed to release closed PTY session", error));
      return { session, reset };
    } catch (error) {
      await session?.close();
      await lease.end().catch(() => {});
      throw error;
    }
  }

  async close(threadId: string): Promise<void> {
    const current = this.active.get(threadId);
    if (!current) return;
    this.active.delete(threadId);
    try {
      await current.session.close();
    } finally {
      await current.lease.end();
    }
  }
}
