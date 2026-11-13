/** Trusted execution context supplied by the runtime, never by model arguments. */
export interface CommandExecutionContext {
  readonly threadId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly cwd: string;
  readonly target: "host" | "sandbox";
}

export interface CommandExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
  readonly error?: string;
  readonly warning?: string;
  readonly output_truncated?: boolean;
  readonly failure?:
    | "canceled"
    | "timed_out"
    | "access_denied"
    | "sandbox_unavailable"
    | "transport_error";
}

/** Execute an already validated argument vector without interpolating it in Wingman. */
export interface CommandExecutor {
  readonly target: CommandExecutionContext["target"];
  execute(
    argv: readonly string[],
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult>;
  /** Execute an approved shell script only when the executor explicitly supports it. */
  executeShell?(script: string, context: CommandExecutionContext): Promise<CommandExecutionResult>;
}
