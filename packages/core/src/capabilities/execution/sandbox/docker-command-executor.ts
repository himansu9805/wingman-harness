import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_PTY_REQUEST_BYTES } from "./pty-session";
import { SandboxSessions } from "./sandbox-sessions";
import { initializeSandboxStorage, sandboxName } from "./sandbox-storage";
import {
  buildSandboxImage,
  checkDocker,
  sandboxNetwork,
  removeSandboxNetwork,
} from "./sandbox-docker-resources";
import pg from "pg";
import type { SandboxInfo, SandboxMonitor } from "./sandbox-monitor";
import { SandboxOutput, type SandboxOutputCursor, type SandboxOutputEvent } from "./sandbox-output";
import type {
  CommandExecutionContext,
  CommandExecutionResult,
  SandboxCommandExecutor,
} from "../command-executor";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
const RESTART_WARNING =
  "The stopped conversation container was restarted. Its previous temporary files were lost when it stopped. The previous shell state was also lost.";

interface ContainerState {
  discard: boolean;
  recoveryReason?: "missing" | "expired";
}

/** Owns one restricted Docker container per conversation and executes approved argv in it. */
export class DockerCommandExecutor implements SandboxCommandExecutor, SandboxMonitor {
  readonly target = "sandbox" as const;
  private readonly pool: pg.Pool;
  private imageId?: string;
  private initialized = false;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private closing = false;
  private readonly output = new SandboxOutput();
  private readonly sessions: SandboxSessions;

  constructor(
    private readonly databaseUrl: string,
    private readonly dockerfileDir: string,
    private readonly options: {
      idleTimeoutHours?: number;
      shutdownAction?: "retain" | "stop";
    } = {},
  ) {
    if (
      !Number.isFinite(options.idleTimeoutHours ?? 24) ||
      (options.idleTimeoutHours ?? 24) < 1 / 60
    ) {
      throw new Error("Sandbox idle timeout must be at least one minute");
    }
    this.pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    this.sessions = new SandboxSessions(databaseUrl, this.output);
  }

  async init(): Promise<void> {
    await checkDocker();
    await initializeSandboxStorage(this.pool);
    this.imageId = await buildSandboxImage(this.dockerfileDir);
    await this.expireIdle();
    this.initialized = true;
    this.sweepTimer = setInterval(() => {
      if (this.closing || this.sweeping) return;
      this.sweeping = this.expireIdle()
        .catch((error: unknown) => {
          console.error("Docker sandbox idle cleanup failed", error);
        })
        .finally(() => {
          this.sweeping = undefined;
        });
    }, 5 * 60_000);
    this.sweepTimer.unref();
  }

  private async container(
    threadId: string,
    db: pg.PoolClient,
    state: ContainerState,
  ): Promise<{ id: string; warning?: string; recoveryReason?: string }> {
    if (!this.imageId) throw new Error("Docker sandbox executor is not initialized");
    const lock = `wingman-docker:${threadId}`;
    let locked = false;
    try {
      await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lock]);
      locked = true;
      const name = `wingman-${createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
      await db.query(
        "INSERT INTO wingman_docker_sessions(thread_id, container_name, owner_token, sandbox_name) VALUES ($1,$2,$3,$4) ON CONFLICT (thread_id) DO NOTHING",
        [threadId, name, randomUUID(), sandboxName(threadId)],
      );
      const { rows } = await db.query<{
        container_name: string;
        container_id: string | null;
        owner_token: string;
        expired_at: Date | null;
        recovery_reason: "missing" | "expired" | null;
      }>(
        "SELECT container_name, container_id, owner_token, expired_at, recovery_reason FROM wingman_docker_sessions WHERE thread_id=$1",
        [threadId],
      );
      const record = rows[0]!;
      state.recoveryReason = record.recovery_reason ?? undefined;
      const prepareReplacement = async (reason: "missing" | "expired") => {
        await removeSandboxNetwork(record.owner_token);
        record.container_name = `wingman-${randomUUID()}`;
        record.owner_token = randomUUID();
        record.container_id = null;
        record.expired_at = null;
        record.recovery_reason = reason;
        await db.query(
          "UPDATE wingman_docker_sessions SET container_name=$2, owner_token=$3, container_id=NULL, expired_at=NULL, recovery_reason=$4 WHERE thread_id=$1",
          [threadId, record.container_name, record.owner_token, reason],
        );
        state.recoveryReason = reason;
        this.output.publish(
          threadId,
          `\r\n[The previous conversation container was ${reason}; its temporary files are unavailable. Preparing a replacement.]\r\n`,
        );
      };
      if (record.expired_at) await prepareReplacement("expired");
      let inspected:
        | { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> } }
        | undefined;
      try {
        const result = await execFileAsync(
          "docker",
          ["inspect", "--type", "container", record.container_id ?? record.container_name],
          { timeout: 10_000, maxBuffer: MAX_OUTPUT },
        );
        inspected = JSON.parse(result.stdout)[0];
      } catch (error) {
        const failure = error as { code?: number; stderr?: string };
        if (failure.code !== 1 || !failure.stderr?.includes("No such container")) throw error;
        if (record.container_id) await prepareReplacement("missing");
      }
      if (!inspected) {
        const networkId = await sandboxNetwork(record.owner_token);
        const { stdout } = await execFileAsync(
          "docker",
          [
            "run",
            "--detach",
            "--name",
            record.container_name,
            "--label",
            `io.wingman.owner=${record.owner_token}`,
            "--network",
            networkId,
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            "256m",
            "--cpus",
            "1",
            "--workdir",
            "/tmp",
            this.imageId,
          ],
          { timeout: 30_000, maxBuffer: MAX_OUTPUT },
        );
        const id = stdout.trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker did not return a container ID");
        await db.query("UPDATE wingman_docker_sessions SET container_id=$2 WHERE thread_id=$1", [
          threadId,
          id,
        ]);
        const warning = record.recovery_reason
          ? `The previous conversation container was ${record.recovery_reason}. A replacement container was created; its previous temporary files are unavailable.`
          : undefined;
        if (warning) this.output.publish(threadId, `\r\n[${warning}]\r\n`);
        return { id, warning, recoveryReason: record.recovery_reason ?? undefined };
      }
      if (
        !inspected.Id ||
        inspected.Config.Labels?.["io.wingman.owner"] !== record.owner_token ||
        (record.container_id && record.container_id !== inspected.Id)
      )
        throw new Error("Conversation container identity does not match its ownership record");
      const restarted = !inspected.State.Running;
      if (restarted) {
        await execFileAsync("docker", ["start", inspected.Id], { timeout: 30_000 });
        this.output.publish(threadId, `\r\n[${RESTART_WARNING}]\r\n`);
      }
      if (!record.container_id)
        await db.query("UPDATE wingman_docker_sessions SET container_id=$2 WHERE thread_id=$1", [
          threadId,
          inspected.Id,
        ]);
      const recoveryWarning = record.recovery_reason
        ? `The previous conversation container was ${record.recovery_reason}. A replacement container was created; its previous temporary files are unavailable.`
        : undefined;
      return {
        id: inspected.Id,
        warning:
          [recoveryWarning, restarted ? RESTART_WARNING : undefined].filter(Boolean).join(" ") ||
          undefined,
        recoveryReason: record.recovery_reason ?? undefined,
      };
    } finally {
      if (locked)
        try {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lock]);
        } catch {
          state.discard = true;
        }
    }
  }

  /** Execute an approved script in the conversation's persistent shell. */
  async executeShell(
    script: string,
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult> {
    return this.runScript(script, context);
  }

  private async runScript(
    script: string,
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult> {
    if (context.target !== "sandbox" || !context.threadId || !script.trim())
      throw new Error("Docker execution requires a conversation and a non-empty command");
    const requestSize = Buffer.byteLength(
      `${JSON.stringify({ type: "execute", id: "00000000-0000-4000-8000-000000000000", command: script })}\n`,
    );
    if (requestSize > MAX_PTY_REQUEST_BYTES) {
      return {
        stdout: "",
        stderr: "",
        exit_code: 1,
        failure: "access_denied",
        error: "Command exceeds the sandbox request size limit; no command was sent.",
      };
    }
    const use = await this.pool.connect().catch(() => undefined);
    if (!use) {
      return {
        stdout: "",
        stderr: "",
        exit_code: 1,
        failure: "sandbox_unavailable",
        error: "Could not access sandbox state; no command was sent.",
      };
    }
    const useLock = `wingman-docker-use:${context.threadId}`;
    let locked = false;
    const state: ContainerState = { discard: false };
    try {
      context.signal?.throwIfAborted();
      await use.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [useLock]);
      locked = true;
      context.signal?.throwIfAborted();
      const sessionState = await use.query<{ shell_uncertain: boolean }>(
        "SELECT shell_uncertain FROM wingman_docker_sessions WHERE thread_id=$1",
        [context.threadId],
      );
      if (sessionState.rows[0]?.shell_uncertain) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 1,
          failure: "sandbox_unavailable",
          error:
            "A previous sandbox command has an uncertain outcome. Stop or remove the sandbox before running another command.",
        };
      }
      await use.query("UPDATE wingman_docker_sessions SET last_used_at=now() WHERE thread_id=$1", [
        context.threadId,
      ]);
      const result = await this.executeInContainer(script, context, context.threadId, use, state);
      if (result.recoveryReason && !result.result.failure) {
        try {
          await use.query(
            "UPDATE wingman_docker_sessions SET recovery_reason=NULL WHERE thread_id=$1 AND recovery_reason=$2 AND container_id=$3",
            [context.threadId, result.recoveryReason, result.containerId],
          );
        } catch {
          // Keep the warning durable if acknowledgement fails; the command already completed.
        }
      }
      return result.result;
    } catch {
      return {
        stdout: "",
        stderr: "",
        exit_code: 1,
        failure: context.signal?.aborted ? "canceled" : "sandbox_unavailable",
        error: context.signal?.aborted
          ? "Sandbox execution was canceled before the command was sent."
          : "Could not access sandbox state; no command was sent.",
      };
    } finally {
      if (locked && !state.discard) {
        try {
          await use.query(
            "UPDATE wingman_docker_sessions SET last_used_at=now() WHERE thread_id=$1",
            [context.threadId],
          );
          await use.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [useLock]);
        } catch {
          state.discard = true;
        }
      }
      use.release(state.discard);
    }
  }

  private async executeInContainer(
    script: string,
    context: CommandExecutionContext,
    threadId: string,
    db: pg.PoolClient,
    state: ContainerState,
  ): Promise<{ result: CommandExecutionResult; recoveryReason?: string; containerId?: string }> {
    let sandbox: { id: string; warning?: string; recoveryReason?: string };
    try {
      context.signal?.throwIfAborted();
      sandbox = await this.container(threadId, db, state);
      context.signal?.throwIfAborted();
    } catch (error) {
      if (!context.signal?.aborted) console.error("Docker sandbox preparation failed", error);
      return {
        result: {
          stdout: "",
          stderr: "",
          exit_code: 1,
          failure: context.signal?.aborted ? "canceled" : "sandbox_unavailable",
          error: context.signal?.aborted
            ? "Sandbox execution was canceled before the command was sent."
            : error instanceof Error && /conversation container identity/i.test(error.message)
              ? error.message
              : "Could not prepare the conversation container; no command was sent.",
          ...(state.recoveryReason && {
            warning: `The previous conversation container was ${state.recoveryReason}; its temporary files are unavailable. A replacement could not be prepared.`,
          }),
        },
      };
    }
    try {
      const { session, reset } = await this.sessions.acquire(threadId, sandbox.id, db);
      context.signal?.throwIfAborted();
      if (reset)
        this.output.publish(
          threadId,
          "\r\n[Shell session restarted; previous shell state is unavailable]\r\n",
          { kind: "session.reset" },
        );
      const commandId = randomUUID();

      // Record intent before sending the command. A crash leaves the session blocked
      // until the user explicitly resets the sandbox, rather than replaying uncertain work.
      await db.query("UPDATE wingman_docker_sessions SET shell_uncertain=true WHERE thread_id=$1", [
        threadId,
      ]);
      const result = await session.execute(script, context.signal, commandId, () => {
        this.output.publish(threadId, `\r\n[Command started]\r\n$ ${script}\r\n`, {
          kind: "command.started",
          commandId,
        });
      });
      let persistenceWarning: string | undefined;
      if (!result.failure) {
        try {
          await db.query(
            "UPDATE wingman_docker_sessions SET shell_uncertain=false WHERE thread_id=$1",
            [threadId],
          );
        } catch {
          persistenceWarning =
            "The command finished, but its state could not be saved. Stop or remove the sandbox before running another command.";
          await this.sessions
            .close(threadId)
            .catch((error: unknown) => console.error("Failed to close PTY session", error));
        }
      } else {
        await this.sessions
          .close(threadId)
          .catch((error: unknown) => console.error("Failed to close uncertain PTY session", error));
      }
      this.output.publish(
        threadId,
        result.failure
          ? "\r\n[Command outcome uncertain]\r\n"
          : `\r\n[Command completed] Exit code: ${result.exit_code}\r\n`,
        {
          kind: result.failure ? "command.uncertain" : "command.completed",
          commandId,
          ...(!result.failure && { exitCode: result.exit_code }),
        },
      );
      const warning = [
        sandbox.warning,
        persistenceWarning,
        reset ? "The shell session restarted; previous shell state is unavailable." : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        recoveryReason: sandbox.recoveryReason,
        containerId: sandbox.id,
        result: { ...result, ...(warning && { warning }) },
      };
    } catch (error) {
      if (!context.signal?.aborted) console.error("PTY session preparation failed", error);
      return {
        recoveryReason: sandbox.recoveryReason,
        containerId: sandbox.id,
        result: {
          stdout: "",
          stderr: "",
          exit_code: 1,
          failure: context.signal?.aborted ? "canceled" : "sandbox_unavailable",
          error: context.signal?.aborted
            ? "Sandbox execution was canceled before the command was sent."
            : "Could not start the sandbox shell session; no command was sent. Existing sandboxes may need to be removed and recreated with the current image.",
          ...(sandbox.warning && { warning: sandbox.warning }),
        },
      };
    }
  }

  /** List only containers recorded by Wingman, with their observed Docker state. */
  async list(): Promise<SandboxInfo[]> {
    const { rows } = await this.pool.query<{
      thread_id: string;
      sandbox_name: string;
      container_id: string | null;
      last_used_at: Date;
      expired_at: Date | null;
      shell_uncertain: boolean;
      shell_session_id: string | null;
    }>(
      "SELECT thread_id, sandbox_name, container_id, last_used_at, expired_at, shell_uncertain, shell_session_id FROM wingman_docker_sessions ORDER BY last_used_at DESC LIMIT 100",
    );
    const results: SandboxInfo[] = new Array(rows.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(rows.length, 5) }, async () => {
        while (next < rows.length) {
          const index = next++;
          const row = rows[index]!;
          let status: SandboxInfo["status"] = row.expired_at
            ? "expired"
            : row.container_id
              ? "unavailable"
              : "provisioning";
          let createdAt: string | null = null;
          if (row.container_id && !row.expired_at) {
            try {
              const { stdout } = await execFileAsync(
                "docker",
                ["inspect", "--format", "{{.State.Running}}|{{.Created}}", row.container_id],
                { timeout: 5_000 },
              );
              const [running, created] = stdout.trim().split("|");
              status = running === "true" ? "running" : "stopped";
              if (created && !Number.isNaN(Date.parse(created))) createdAt = created;
            } catch (error) {
              const failure = error as { code?: number; stderr?: string };
              if (failure.code === 1 && failure.stderr?.includes("No such")) status = "missing";
            }
          }
          let sessionStatus: SandboxInfo["sessionStatus"] = row.shell_uncertain
            ? "needs_reset"
            : "inactive";
          const current = this.sessions.get(row.thread_id);
          if (current && !current.session.isClosed) {
            sessionStatus = current.session.isExecuting ? "running" : "ready";
          } else if (row.shell_session_id && !row.expired_at) {
            const db = await this.pool.connect();
            let locked = false;
            let discard = false;
            try {
              const ownership = await db.query<{ acquired: boolean }>(
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
                [`wingman-pty-session:${row.thread_id}`],
              );
              locked = Boolean(ownership.rows[0]?.acquired);
              if (!locked) sessionStatus = "remote";
            } catch {
              sessionStatus = "unavailable";
              discard = true;
            } finally {
              if (locked) {
                try {
                  await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
                    `wingman-pty-session:${row.thread_id}`,
                  ]);
                } catch {
                  discard = true;
                }
              }
              db.release(discard);
            }
          }
          results[index] = {
            threadId: row.thread_id,
            name: row.sandbox_name,
            sessionStatus,
            containerId: row.container_id,
            status,
            createdAt,
            lastUsedAt: row.last_used_at.toISOString(),
            expiredAt: row.expired_at?.toISOString() ?? null,
          };
        }
      }),
    );
    return results;
  }

  /** Subscribe to sequenced output for a known sandbox, including bounded replay. */
  async subscribeEvents(
    threadId: string,
    after: SandboxOutputCursor | null,
    listener: (event: SandboxOutputEvent) => void,
  ) {
    const found = await this.pool.query(
      "SELECT 1 FROM wingman_docker_sessions WHERE thread_id=$1",
      [threadId],
    );
    if (!found.rowCount) throw new Error("Sandbox not found");
    return this.output.subscribeEvents(threadId, after, listener);
  }

  /** Removes idle containers, leaving an expired record so lost files are not silently replaced. */
  async expireIdle(): Promise<void> {
    const hours = this.options.idleTimeoutHours ?? 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const { rows } = await this.pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM wingman_docker_sessions WHERE expired_at IS NULL AND last_used_at < $1",
      [cutoff],
    );
    for (const row of rows) await this.remove(row.thread_id, cutoff, true);
  }

  /** Resize a locally owned, active PTY session. */
  async resize(threadId: string, cols: number, rows: number): Promise<boolean> {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 500 ||
      rows < 5 ||
      rows > 200
    )
      throw new Error("Invalid terminal dimensions");
    this.sessions.resize(threadId, cols, rows);
    return true;
  }

  /** Stop an owned sandbox after its active commands finish. */
  async stop(threadId: string): Promise<boolean> {
    const db = await this.pool.connect();
    const key = `wingman-docker-use:${threadId}`;
    let locked = false;
    let discard = false;
    try {
      await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      locked = true;
      const { rows } = await db.query<{ container_id: string | null }>(
        "SELECT container_id FROM wingman_docker_sessions WHERE thread_id=$1 AND expired_at IS NULL",
        [threadId],
      );
      if (!rows[0]?.container_id) return false;
      await this.sessions.close(threadId);
      await execFileAsync("docker", ["stop", rows[0].container_id], { timeout: 30_000 });
      await db.query(
        "UPDATE wingman_docker_sessions SET shell_uncertain=false WHERE thread_id=$1",
        [threadId],
      );
      this.output.publish(threadId, "\r\n[Sandbox stopped; temporary files were removed]\r\n");
      return true;
    } finally {
      if (locked) {
        try {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        } catch {
          discard = true;
        }
      }
      db.release(discard);
    }
  }

  async release(threadId: string): Promise<void> {
    await this.remove(threadId);
  }

  private async remove(threadId: string, expiredBefore?: Date, tryOnly = false): Promise<void> {
    const db = await this.pool.connect();
    const lock = `wingman-docker:${threadId}`;
    const useLock = `wingman-docker-use:${threadId}`;
    let locked = false;
    let useLocked = false;
    try {
      if (tryOnly) {
        const result = await db.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [useLock],
        );
        if (!result.rows[0]?.acquired) return;
      } else {
        await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [useLock]);
      }
      useLocked = true;
      await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lock]);
      locked = true;
      const { rows } = await db.query<{
        container_id: string | null;
        container_name: string;
        owner_token: string;
        last_used_at: Date;
        expired_at: Date | null;
      }>(
        "SELECT container_id, container_name, owner_token, last_used_at, expired_at FROM wingman_docker_sessions WHERE thread_id=$1",
        [threadId],
      );
      const record = rows[0];
      if (expiredBefore && (!record || record.expired_at || record.last_used_at >= expiredBefore))
        return;
      let id = record?.container_id;
      if (record && !id) {
        try {
          const { stdout } = await execFileAsync(
            "docker",
            ["inspect", "--type", "container", record.container_name],
            { timeout: 10_000, maxBuffer: MAX_OUTPUT },
          );
          const container = JSON.parse(stdout)[0] as {
            Id: string;
            Config: { Labels: Record<string, string> };
          };
          if (container.Config.Labels?.["io.wingman.owner"] !== record.owner_token)
            throw new Error("Conversation container identity does not match its ownership record");
          id = container.Id;
        } catch (error) {
          const failure = error as { code?: number; stderr?: string };
          if (failure.code !== 1 || !failure.stderr?.includes("No such container")) throw error;
        }
      }
      await this.sessions.close(threadId);
      this.sessions.forgetSize(threadId);
      if (id) {
        try {
          await execFileAsync("docker", ["rm", "--force", id], { timeout: 30_000 });
        } catch (error) {
          const failure = error as { code?: number; stderr?: string };
          if (failure.code !== 1 || !failure.stderr?.includes("No such container")) throw error;
        }
      }
      if (record) await removeSandboxNetwork(record.owner_token);
      if (expiredBefore) {
        await db.query("UPDATE wingman_docker_sessions SET expired_at=now() WHERE thread_id=$1", [
          threadId,
        ]);
        this.output.publish(threadId, "\r\n[Sandbox expired; temporary files were removed]\r\n");
      } else {
        await db.query("DELETE FROM wingman_docker_sessions WHERE thread_id=$1", [threadId]);
        this.output.publish(threadId, "\r\n[Sandbox removed]\r\n");
        this.output.clear(threadId);
      }
    } finally {
      let discard = false;
      if (locked)
        try {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lock]);
        } catch {
          discard = true;
        }
      if (useLocked) {
        try {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [useLock]);
        } catch {
          discard = true;
        }
      }
      db.release(discard);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.sweeping;
    try {
      await this.sessions.closeAll();
      if (this.initialized && this.options.shutdownAction === "stop")
        await this.stopIdleContainers();
    } finally {
      await this.pool.end();
    }
  }

  private async stopIdleContainers(): Promise<void> {
    const { rows } = await this.pool.query<{ thread_id: string; container_id: string }>(
      "SELECT thread_id, container_id FROM wingman_docker_sessions WHERE container_id IS NOT NULL AND expired_at IS NULL",
    );
    for (const row of rows) {
      const db = await this.pool.connect();
      const key = `wingman-docker-use:${row.thread_id}`;
      let locked = false;
      try {
        const result = await db.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [key],
        );
        if (!result.rows[0]?.acquired) continue;
        locked = true;
        try {
          await execFileAsync("docker", ["stop", row.container_id], { timeout: 30_000 });
        } catch (error) {
          const failure = error as { code?: number; stderr?: string };
          if (failure.code !== 1 || !failure.stderr?.includes("No such container")) throw error;
        }
      } finally {
        let discard = false;
        if (locked)
          try {
            await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
          } catch {
            discard = true;
          }
        db.release(discard);
      }
    }
  }
}
