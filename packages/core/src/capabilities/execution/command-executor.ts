/** Trusted execution context supplied by the runtime, never by model arguments. */
export interface CommandExecutionContext {
  readonly threadId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly target: "sandbox";
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

/** Execute approved scripts in a sandbox's persistent shell. */
export interface SandboxCommandExecutor {
  readonly target: "sandbox";
  executeShell(script: string, context: CommandExecutionContext): Promise<CommandExecutionResult>;
}

export type CommandExecutor = SandboxCommandExecutor;
