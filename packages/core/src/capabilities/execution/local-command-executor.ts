import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CommandExecutor,
  CommandExecutionContext,
  CommandExecutionResult,
} from "./command-executor";

const execFilePromise = promisify(execFile);

/** Execute a validated command on the host with the existing 30-second limit. */
export class LocalCommandExecutor implements CommandExecutor {
  readonly target = "host" as const;
  async execute(
    argv: readonly string[],
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult> {
    if (context.target !== this.target) throw new Error("Host executor requires a host target");
    const [file, ...args] = argv;
    if (!file) throw new Error("Command arguments must not be empty");
    try {
      const { stdout, stderr } = await execFilePromise(file, args, {
        timeout: 30_000,
        signal: context.signal,
        cwd: context.cwd,
      });
      return { stdout: stdout || "", stderr: stderr || "", exit_code: 0 };
    } catch (error) {
      const executionError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: executionError.stdout || "",
        stderr: executionError.stderr || "",
        exit_code: typeof executionError.code === "number" ? executionError.code : 1,
        error: executionError.message || "Unknown error",
      };
    }
  }
}
