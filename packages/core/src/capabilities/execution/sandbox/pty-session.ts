import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { CommandExecutionResult } from "../command-executor";

const MAX_OUTPUT = 1024 * 1024;
export const MAX_PTY_REQUEST_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 90_000;

type SessionEvent =
  | { type: "session.ready" }
  | { type: "session.resized"; cols: number; rows: number }
  | { type: "session.closed" | "session.error"; reason: string }
  | { type: "command.started"; id: string }
  | { type: "command.output"; id: string | null; text: string }
  | { type: "command.completed"; id: string; exitCode: number }
  | { type: "command.uncertain" | "command.rejected"; id: string; reason: string };

interface Pending {
  id: string;
  output: string;
  truncated: boolean;
  started(): void;
  finish(result: CommandExecutionResult): void;
}

/** Owns the supervisor connection for one persistent sandbox PTY session. */
export class PtySession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private pending?: Pending;
  private ready = false;
  private closed = false;
  private diagnostic = "";
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private readonly startup: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    containerId: string,
    private readonly onOutput: (text: string, commandId: string | null) => void,
  ) {
    this.startup = new Promise((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    this.child = spawn(
      "docker",
      ["exec", "-i", containerId, "node", "/usr/local/lib/wingman/pty-supervisor.cjs"],
      { stdio: "pipe" },
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostic = (this.diagnostic + chunk.toString("utf8")).slice(-4096);
    });
    this.child.stdin.on("error", (error) => this.onExit(`PTY input failed: ${error.message}`));
    this.heartbeat = setInterval(() => {
      if (!this.closed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded)
        this.child.stdin.write(`${JSON.stringify({ type: "ping" })}\n`);
    }, 5_000);
    this.heartbeat.unref();
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.onExit(error.message);
        resolve();
      });
      this.child.once("close", (code) => {
        this.onExit(`PTY supervisor exited (${code ?? "unknown"})`);
        resolve();
      });
    });
  }

  /** Wait until the shell supervisor is ready to accept a command. */
  async start(): Promise<void> {
    const timer = setTimeout(() => this.onExit("PTY supervisor startup timed out"), 10_000);
    try {
      await this.startup;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Execute one approved script; stdout and stderr are merged by the PTY. */
  async execute(
    script: string,
    signal?: AbortSignal,
    commandId = randomUUID(),
    onStarted: () => void = () => {},
  ): Promise<CommandExecutionResult> {
    await this.start();
    if (this.closed) throw new Error("PTY session is closed");
    if (this.pending) throw new Error("PTY session is already executing a command");
    signal?.throwIfAborted();
    const id = commandId;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => interrupt("Command was interrupted; its outcome is uncertain.");
      const finish = (result: CommandExecutionResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending = undefined;
        resolve(result);
      };
      const interrupt = (error: string) => {
        const pending = this.pending;
        if (!pending) return;
        this.closed = true;
        this.requestClose();
        pending.finish({
          stdout: pending.output,
          stderr: "",
          exit_code: 1,
          failure: "transport_error",
          error,
          ...(pending.truncated && { output_truncated: true }),
        });
      };
      this.pending = { id, output: "", truncated: false, started: onStarted, finish };
      timer = setTimeout(
        () => interrupt("Command timed out; its outcome is uncertain."),
        COMMAND_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(
        `${JSON.stringify({ type: "execute", id, command: script })}\n`,
        (error) => {
          if (error) interrupt("Could not send command to the PTY; its outcome is uncertain.");
        },
      );
    });
  }

  /** Resize the PTY without sending terminal input. */
  resize(cols: number, rows: number): void {
    if (
      this.closed ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 500 ||
      rows < 5 ||
      rows > 200
    )
      throw new Error("Invalid PTY dimensions or inactive session");
    this.child.stdin.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`);
  }

  /** Close the supervisor and wait for its shell to exit. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.requestClose();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.lines.close();
    }
  }

  /** Resolve when the supervisor process has exited. */
  waitClosed(): Promise<void> {
    return this.exited;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isExecuting(): boolean {
    return Boolean(this.pending) && !this.closed;
  }

  private onLine(line: string): void {
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      this.onExit("Invalid PTY supervisor event");
      return;
    }
    if (event.type === "session.ready") {
      this.ready = true;
      this.startupResolve();
      return;
    }
    if (event.type === "command.started" && this.pending && event.id === this.pending.id) {
      this.pending.started();
      return;
    }
    if (event.type === "command.output" && typeof event.text === "string") {
      this.onOutput(event.text, event.id);
      if (this.pending && event.id === this.pending.id) {
        const remaining = MAX_OUTPUT - this.pending.output.length;
        this.pending.output += event.text.slice(0, Math.max(0, remaining));
        if (event.text.length > remaining) this.pending.truncated = true;
      }
      return;
    }
    if (
      event.type === "command.completed" &&
      this.pending &&
      event.id === this.pending.id &&
      Number.isInteger(event.exitCode)
    ) {
      const pending = this.pending;
      pending.finish({
        stdout: pending.output,
        stderr: "",
        exit_code: event.exitCode,
        ...(pending.truncated && { output_truncated: true }),
      });
      return;
    }
    if (event.type === "command.uncertain" || event.type === "command.rejected") {
      if (this.pending && event.id === this.pending.id) {
        const pending = this.pending;
        pending.finish({
          stdout: pending.output,
          stderr: "",
          exit_code: 1,
          failure: "transport_error",
          error: `PTY command outcome is uncertain: ${event.reason}`,
          ...(pending.truncated && { output_truncated: true }),
        });
      }
      this.onExit(`PTY command failed: ${event.reason}`);
    } else if (event.type === "session.closed" || event.type === "session.error")
      this.onExit(`PTY session ended: ${event.reason}`);
  }

  private onExit(reason: string): void {
    if (this.diagnostic.trim()) reason += `: ${this.diagnostic.trim()}`;
    this.closed = true;
    clearInterval(this.heartbeat);
    if (!this.ready) this.startupReject(new Error(reason));
    if (this.pending) {
      const pending = this.pending;
      pending.finish({
        stdout: pending.output,
        stderr: "",
        exit_code: 1,
        failure: "transport_error",
        error: `${reason}; the command outcome is uncertain.`,
        ...(pending.truncated && { output_truncated: true }),
      });
    }
    this.requestClose();
  }

  private requestClose(): void {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded)
      this.child.stdin.end(`${JSON.stringify({ type: "close" })}\n`);
  }
}
