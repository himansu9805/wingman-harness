import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { confirm } from "@/core/confirm";
import { parse } from "shell-quote";

const execFilePromise = promisify(execFile);

export type Verdict = "allow" | "deny" | "ask";

const RULESET = {
  allow: ["docker ps", "docker ps *", "git status", "git log *", "ls *", "pwd"],
  deny: ["rm *", "sudo *", "shutdown *", "reboot *", "kill *", "killall *"],
};

/**
 * Splits a command into argv without a shell.
 *
 * @param command The command to split into argv.
 * @returns The argv, or `null` if it uses shell syntax (pipes, `;`, `$()`,
 * redirects, globs) that can't be checked as a single command.
 */
export function toArgv(command: string): string[] | null {
  const tokens = parse(command);
  if (!tokens.every((t): t is string => typeof t === "string")) return null;
  return tokens.length > 0 ? tokens : null;
}

/**
 * Checks if a command matches a pattern.
 *
 * @param argv The command to check, split into argv.
 * @param pattern The pattern to match against.
 * @returns `true` if the command matches the pattern, `false` otherwise.
 */
function matches(argv: string[], pattern: string): boolean {
  const parts = pattern.trim().split(/\s+/);
  const wildcard = parts.at(-1) === "*";
  const prefix = wildcard ? parts.slice(0, -1) : parts;
  if (argv.length < prefix.length) return false;
  if (!wildcard && argv.length !== prefix.length) return false;
  return prefix.every((p, i) => p === argv[i]);
}

/**
 * Decides whether a command may run. Deny wins over allow.
 *
 * @param argv The command to check, split into argv.
 * @returns "allow" if the command is allowed, "deny" if it is denied, or "ask"
 * if the user should be prompted for confirmation.
 */
export function checkCommand(argv: string[]): Verdict {
  if (RULESET.deny.some((p) => matches(argv, p))) return "deny";
  if (RULESET.allow.some((p) => matches(argv, p))) return "allow";
  return "ask";
}

const executeBashCommand = tool(
  async ({ command }) => {
    const argv = toArgv(command);
    if (!argv) {
      return JSON.stringify({
        error:
          "Rejected: shell syntax (pipes, ;, &&, $(), redirects, wildcards) " +
          "is not supported. Run each command separately, e.g. 'docker ps' " +
          "then 'docker stats --no-stream', and combine the results yourself.",
      });
    }
    const verdict = checkCommand(argv);
    if (verdict === "deny") {
      return JSON.stringify({
        error:
          "Blocked: this command is not allowed on this machine. Don't retry " +
          "it or a variant. Tell the user it is blocked.",
      });
    }
    if (
      verdict === "ask" &&
      !(await confirm(` ▶️ Execute command: "${command}"? [y/N]: `))
    ) {
      return JSON.stringify({
        error:
          "Declined: the user chose not to run this command. Don't retry it. " +
          "Ask the user how they'd like to proceed.",
      });
    }
    const [file, ...args] = argv;
    try {
      // Execute the bash command (timeout capped at 30 seconds)
      const { stdout, stderr } = await execFilePromise(file, args, {
        timeout: 30000,
      });
      return JSON.stringify({
        stdout: stdout || "",
        stderr: stderr || "",
        exit_code: 0,
      });
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };

      return JSON.stringify({
        stdout: execError.stdout || "",
        stderr: execError.stderr || "",
        exit_code: typeof execError.code === "number" ? execError.code : 1,
        error: execError.message || "Unknown error",
      });
    }
  },
  {
    name: "exec_bash_command",
    description:
      "Runs one command on the user's computer and returns its stdout, " +
      "stderr and exit_code. Use it to inspect the machine: containers, " +
      "files, processes, git, disk usage. Call it directly: it asks the user " +
      "for approval itself when needed, so don't ask permission in your reply " +
      "first. Only one plain command per call: pipes, ;, &&, $(), redirects " +
      "and wildcards are rejected. Some commands are blocked entirely.",
    schema: z.object({
      command: z
        .string()
        .describe(
          "One plain command with its arguments. Right: 'docker ps', 'ls -la /tmp', 'git status'. Wrong (rejected): 'ps aux | grep postgres', 'cd src && ls'.",
        ),
    }),
  },
);

export const bashTools = [executeBashCommand];
