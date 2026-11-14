import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("../sandbox/pty-supervisor.cjs", import.meta.url));

async function closeSupervisor(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  child.stdin.on("error", () => {});
  if (!child.stdin.destroyed && !child.stdin.writableEnded)
    child.stdin.end(`${JSON.stringify({ type: "close" })}\n`);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

test(
  "PTY session carries shell state across commands and returns command status",
  { timeout: 15_000 },
  async (t) => {
    const child = spawn(process.execPath, [supervisor], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => closeSupervisor(child));
    const events = [];
    let wake;
    createInterface({ input: child.stdout }).on("line", (line) => {
      events.push(JSON.parse(line));
      wake?.();
    });
    const waitFor = async (predicate) => {
      while (!events.some(predicate)) {
        await new Promise((resolve, reject) => {
          const onExit = (code) => reject(new Error(`Supervisor exited: ${code}`));
          wake = () => {
            child.off("exit", onExit);
            resolve();
          };
          child.once("exit", onExit);
        });
      }
      return events.find(predicate);
    };
    await waitFor((event) => event.type === "session.ready");
    const run = async (id, command) => {
      child.stdin.write(`${JSON.stringify({ type: "execute", id, command })}\n`);
      return waitFor((event) => event.type === "command.completed" && event.id === id);
    };
    assert.equal((await run("first", "cd /tmp; export WINGMAN_TEST=retained")).exitCode, 0);
    assert.equal(
      (await run("second", 'printf \'%s:%s\\n\' "$PWD" "$WINGMAN_TEST"; test -t 1')).exitCode,
      0,
    );
    assert(
      events.some(
        (event) => event.type === "command.output" && event.text.includes("/tmp:retained"),
      ),
    );
    child.stdin.write(`${JSON.stringify({ type: "resize", cols: 100, rows: 40 })}\n`);
    await waitFor((event) => event.type === "session.resized");
    assert.equal((await run("size", "stty size")).exitCode, 0);
    assert(
      events.some(
        (event) =>
          event.type === "command.output" && event.id === "size" && event.text.includes("40 100"),
      ),
    );
    assert.equal((await run("history-check", "history 10")).exitCode, 0);
    assert(
      !events.some(
        (event) =>
          event.type === "command.output" &&
          event.id === "history-check" &&
          event.text.includes("wingman-command"),
      ),
    );
    assert.equal((await run("third", "false")).exitCode, 1);
    assert.equal((await run("invalid-utf8", "printf '\\377'")).exitCode, 0);
    assert(
      events.some(
        (event) =>
          event.type === "command.output" &&
          event.id === "invalid-utf8" &&
          event.text.includes("�"),
      ),
    );

    const longValue = "x".repeat(7000);
    assert.equal((await run("long-script", `printf '%s' '${longValue}'`)).exitCode, 0);
    const output = events
      .filter((event) => event.type === "command.output" && event.id === "long-script")
      .map((event) => event.text)
      .join("");
    assert(output.includes(longValue));
    for (let i = 0; i < 100; i++) {
      assert.equal((await run(`rapid-${i}`, "printf rapid")).exitCode, 0);
    }
  },
);

test(
  "PTY session reports an uncertain command if the shell exits",
  { timeout: 15_000 },
  async (t) => {
    const child = spawn(process.execPath, [supervisor], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => closeSupervisor(child));
    const events = [];
    let wake;
    createInterface({ input: child.stdout }).on("line", (line) => {
      events.push(JSON.parse(line));
      wake?.();
    });
    const waitFor = async (predicate) => {
      while (!events.some(predicate)) {
        await new Promise((resolve, reject) => {
          const onExit = (code) => reject(new Error(`Supervisor exited: ${code}`));
          wake = () => {
            child.off("exit", onExit);
            resolve();
          };
          child.once("exit", onExit);
        });
      }
      return events.find(predicate);
    };
    await waitFor((event) => event.type === "session.ready");
    child.stdin.write(`${JSON.stringify({ type: "execute", id: "exit-1", command: "exit" })}\n`);
    const uncertain = await waitFor((event) => event.type === "command.uncertain");
    assert.equal(uncertain.id, "exit-1");
    assert(!events.some((event) => event.type === "command.completed"));
  },
);

test("PTY sessions do not read or write the host shell history", { timeout: 15_000 }, async (t) => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "wingman-pty-history-"));
  const history = join(directory, "history");
  await writeFile(history, "private-existing-entry\n");
  const child = spawn(process.execPath, [supervisor], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HISTFILE: history },
  });
  t.after(async () => {
    await closeSupervisor(child);
    await rm(directory, { recursive: true, force: true });
  });
  const events = [];
  let wake;
  createInterface({ input: child.stdout }).on("line", (line) => {
    events.push(JSON.parse(line));
    wake?.();
  });
  const waitFor = async (predicate) => {
    while (!events.some(predicate))
      await new Promise((resolve) => {
        wake = resolve;
      });
  };
  await waitFor((event) => event.type === "session.ready");
  child.stdin.write(
    `${JSON.stringify({ type: "execute", id: "history-test", command: "history 10" })}\n`,
  );
  await waitFor((event) => event.type === "command.completed" && event.id === "history-test");
  assert(
    !events.some(
      (event) => event.type === "command.output" && event.text.includes("private-existing-entry"),
    ),
  );
  await closeSupervisor(child);
  assert.equal(await readFile(history, "utf8"), "private-existing-entry\n");
});

test(
  "lost controller heartbeat stops the session and reports an uncertain command",
  { timeout: 15_000 },
  async (t) => {
    const child = spawn(process.execPath, [supervisor], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WINGMAN_PTY_HEARTBEAT_MS: "250" },
    });
    t.after(() => closeSupervisor(child));
    const events = [];
    let wake;
    createInterface({ input: child.stdout }).on("line", (line) => {
      events.push(JSON.parse(line));
      wake?.();
    });
    const waitFor = async (predicate) => {
      while (!events.some(predicate))
        await new Promise((resolve) => {
          wake = resolve;
        });
      return events.find(predicate);
    };
    await waitFor((event) => event.type === "session.ready");
    child.stdin.write(
      `${JSON.stringify({ type: "execute", id: "heartbeat-test", command: "sleep 10" })}\n`,
    );
    const uncertain = await waitFor((event) => event.type === "command.uncertain");
    assert.equal(uncertain.id, "heartbeat-test");
    assert.match(uncertain.reason, /heartbeat expired/);
    assert(!events.some((event) => event.type === "command.completed"));
  },
);

test(
  "PTY output resumes without loss after the controller stops reading",
  { timeout: 15_000 },
  async (t) => {
    const child = spawn(process.execPath, [supervisor], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => closeSupervisor(child));
    const events = [];
    let wake;
    createInterface({ input: child.stdout }).on("line", (line) => {
      events.push(JSON.parse(line));
      wake?.();
    });
    const waitFor = async (predicate) => {
      while (!events.some(predicate)) {
        await new Promise((resolve, reject) => {
          const onExit = (code) => reject(new Error(`Supervisor exited: ${code}`));
          wake = () => {
            child.off("exit", onExit);
            resolve();
          };
          child.once("exit", onExit);
        });
      }
    };
    await waitFor((event) => event.type === "session.ready");
    child.stdout.pause();
    child.stdin.write(
      `${JSON.stringify({ type: "execute", id: "large", command: "head -c 2097152 /dev/zero | tr '\\000' x" })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    child.stdout.resume();
    await waitFor((event) => event.type === "command.completed" && event.id === "large");
    const output = events
      .filter((event) => event.type === "command.output" && event.id === "large")
      .map((event) => event.text)
      .join("");
    assert.equal(output.length, 2097152);
    assert.equal(output, "x".repeat(2097152));
  },
);
