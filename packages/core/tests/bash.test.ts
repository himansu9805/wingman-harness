import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCommand, toArgv } from "../src/tools/bash.ts";

describe("toArgv", () => {
  for (const [command, expected] of [
    ["pwd", ["pwd"]],
    ["  git   status\t--short  ", ["git", "status", "--short"]],
    ['echo "hello world"', ["echo", "hello world"]],
    ["echo 'hello world'", ["echo", "hello world"]],
    ['echo "" \'\'', ["echo", "", ""]],
    ["echo hello\\ world", ["echo", "hello world"]],
    ['echo "a|b;c&&d>e*?"', ["echo", "a|b;c&&d>e*?"]],
    ["echo '*.ts'", ["echo", "*.ts"]],
    ["echo '$(pwd)'", ["echo", "$(pwd)"]],
    ["echo '`pwd`'", ["echo", "`pwd`"]],
    ['echo "[ab].ts"', ["echo", "[ab].ts"]],
    ["echo \\`pwd\\`", ["echo", "`pwd`"]],
    ['echo "\\$(pwd)"', ["echo", "$(pwd)"]],
  ] as const) {
    it(`parses ${JSON.stringify(command)} as literal argv`, () => {
      assert.deepEqual(toArgv(command), expected);
    });
  }

  for (const command of ["", " ", "\t\n"]) {
    it(`rejects empty input ${JSON.stringify(command)}`, () => {
      assert.equal(toArgv(command), null);
    });
  }

  for (const command of [
    "pwd | cat",
    "pwd; ls",
    "pwd && ls",
    "pwd || ls",
    "pwd & ls",
    "echo hello > output.txt",
    "echo hello >> output.txt",
    "cat < input.txt",
    "cat 2> errors.txt",
    "cat 2>&1",
    "ls *.ts",
    "ls file?.ts",
    "ls [ab].ts",
    "echo $(pwd)",
    'echo "$(pwd)"',
    "echo `pwd`",
  ]) {
    it(`rejects shell syntax in ${JSON.stringify(command)}`, () => {
      assert.equal(toArgv(command), null);
    });
  }
});

describe("checkCommand", () => {
  for (const argv of [
    ["pwd"],
    ["git", "status"],
    ["docker", "ps"],
    ["docker", "ps", "--all"],
    ["git", "log"],
    ["git", "log", "--oneline", "-5"],
    ["ls"],
    ["ls", "-la", "/tmp"],
  ]) {
    it(`allows ${JSON.stringify(argv)}, including zero or more trailing-star arguments`, () => {
      assert.equal(checkCommand(argv), "allow");
    });
  }

  // The fixed ruleset has no overlapping allow/deny patterns; exercise every
  // deny prefix without changing production rules to manufacture an overlap.
  for (const executable of ["rm", "sudo", "shutdown", "reboot", "kill", "killall"]) {
    for (const args of [[], ["target"], ["-f", "target"]]) {
      const argv = [executable, ...args];
      it(`denies ${JSON.stringify(argv)}`, () => {
        assert.equal(checkCommand(argv), "deny");
      });
    }
  }

  for (const argv of [
    [],
    ["uptime"],
    ["git"],
    ["docker"],
    ["git", "diff"],
    ["pwd", "--help"],
    ["git", "status", "--short"],
    ["pwdx"],
    ["lsof"],
    ["git", "status-extra"],
    ["git", "logger"],
    ["docker", "ps-extra"],
    ["rm-safe", "target"],
    ["sudoku"],
    ["shutdown-helper"],
    ["reboot-helper"],
    ["kill-helper"],
    ["killall-helper"],
    ["/bin/ls"],
    ["/bin/rm", "target"],
  ]) {
    it(`asks for ${JSON.stringify(argv)} rather than matching a partial name or an exact rule with extra arguments`, () => {
      assert.equal(checkCommand(argv), "ask");
    });
  }
});
