import type { CommandExecutor } from "./execution/command-executor";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { commandApproval, type CommandApproval } from "../conversations/approvals";
export type { CommandApproval } from "../conversations/approvals";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { parse } from "shell-quote";

export type Verdict = "allow" | "ask";

const RULESET = {
  allow: ["docker ps", "docker ps *", "git status", "git log *", "ls *", "pwd"],
};

/** Catches shell constructs that shell-quote otherwise preserves as text. */
function hasUnsupportedSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\" && (!quote || /["$`\\\n]/.test(command[i + 1] ?? ""))) {
      i++;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "$" && command[i + 1] === "(")) return true;
    if (!quote && char === "[" && command.indexOf("]", i + 1) !== -1) return true;
  }
  return false;
}

/**
 * Splits a command into argv without a shell.
 *
 * @param command The command to split into argv.
 * @returns The argv, or `null` if it uses shell syntax (pipes, `;`, `$()`,
 * redirects, globs) that can't be checked as a single command.
 */
export function toArgv(command: string): string[] | null {
  if (hasUnsupportedSyntax(command)) return null;
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
  if (RULESET.allow.some((pattern) => matches(argv, pattern))) return "allow";
  return "ask";
}

/** Bind a command tool to an executor chosen by trusted application configuration. */
export function createCommandTool(executor: CommandExecutor) {
  if (!executor || executor.target !== "sandbox" || typeof executor.executeShell !== "function") {
    throw new Error("Sandbox execution requires a persistent shell executor");
  }
  return tool(
    async ({ command }, runtime: ToolRuntime) => {
      const argv = toArgv(command);
      if (!command.trim()) return JSON.stringify({ error: "Rejected: command must not be empty." });
      const safe = argv && /^[\w./ \t-]+$/.test(command) && checkCommand(argv) === "allow";
      const verdict = safe ? "allow" : "ask";
      if (verdict === "ask") {
        // Pauses the run here. On resume the tool reruns from the top, and
        // interrupt() returns the value passed to Command({ resume }).
        const approved = interrupt<CommandApproval, boolean>(
          commandApproval(command, runtime, executor.target),
        );
        if (!approved) {
          return JSON.stringify({
            error:
              "Declined: the user chose not to run this command. Don't retry " +
              "it or a variant on your own. Wait for the user's next instruction. " +
              "If the user explicitly asks to run it again, call this tool for " +
              "fresh approval. The retry request itself is not approval.",
          });
        }
      }
      const configuredThreadId = runtime.config.configurable?.conversation_id;
      const context = {
        threadId: typeof configuredThreadId === "string" ? configuredThreadId : undefined,
        signal: runtime.config.signal,
        target: executor.target,
      };
      const result = await executor.executeShell(command, context);
      return JSON.stringify(result);
    },
    {
      name: "exec_bash_command",
      description:
        "Runs a command in the isolated Linux sandbox and returns stdout, stderr and exit_code. " +
        "Call it directly; it requests approval when needed. Commands share a persistent PTY shell; " +
        "stdout and stderr are combined, and background output may appear during later commands. " +
        "Shell syntax, including heredocs and redirection, requires approval for the complete script.",
      schema: z.object({
        command: z
          .string()
          .describe(
            "A sandbox command or shell script. Shell syntax requires approval for the entire script.",
          ),
      }),
    },
  );
}
