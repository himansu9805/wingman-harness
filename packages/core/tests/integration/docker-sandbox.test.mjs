import { quote } from "shell-quote";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import pg from "pg";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { DockerCommandExecutor } from "../../src/capabilities/execution/sandbox/docker-command-executor.ts";
import { PtySession } from "../../src/capabilities/execution/sandbox/pty-session.ts";
import { createCommandTool } from "../../src/capabilities/commands.ts";
import { deleteThreadState } from "../../src/conversations/history.ts";
import { startTurn, resumeTurn, getPendingApprovals } from "../../src/conversations/turn.ts";

const url = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!url) throw new Error("Set TEST_POSTGRES_CONNECTION_STRING to an isolated test database");

class ScriptedShellModel extends BaseChatModel {
  _llmType() {
    return "sandbox-shell-test";
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const lastHuman = messages.findLastIndex(HumanMessage.isInstance);
    const result = messages.slice(lastHuman + 1).find(ToolMessage.isInstance);
    const message = result
      ? new AIMessage(result.text)
      : new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "exec_bash_command",
              args: { command: messages[lastHuman].text },
              id: "sandbox-script",
              type: "tool_call",
            },
          ],
        });
    return { generations: [{ text: message.text, message }] };
  }
}

test(
  "Docker sandbox persists files within one conversation and isolates commands",
  { timeout: 180_000 },
  async (t) => {
    const schema = `docker_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const executor = new DockerCommandExecutor(
      scopedUrl.toString(),
      new URL("../../sandbox", import.meta.url).pathname,
    );
    const threadId = `integration-${randomUUID()}`;
    const missingThreadId = `integration-${randomUUID()}`;
    const nextThreadId = `integration-${randomUUID()}`;
    const context = { threadId, target: "sandbox", cwd: "/private/host" };
    t.after(async () => {
      await executor.release(threadId);
      await executor.release(missingThreadId);
      await executor.release(nextThreadId);
      await executor.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await executor.init();
    const pwd = await executor.executeShell(quote(["pwd"]), context);
    assert.equal(pwd.exit_code, 0);
    assert.equal(pwd.stdout.trim(), "/tmp");
    const liveEvents = [];
    const eventSubscription = await executor.subscribeEvents(threadId, null, (event) =>
      liveEvents.push(event),
    );
    assert(eventSubscription.events.some((event) => event.text.includes("/tmp")));
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    eventSubscription.unsubscribe();
    assert(liveEvents.some((event) => event.text.includes("/tmp")));
    assert(liveEvents.every((event) => event.generation === eventSubscription.cursor.generation));
    const replay = await executor.subscribeEvents(threadId, eventSubscription.cursor, () => {});
    assert.equal(replay.gap, false);
    assert(replay.events.some((event) => event.text.includes("/tmp")));
    replay.unsubscribe();
    const parallel = await Promise.all(
      Array.from({ length: 12 }, () => executor.executeShell(quote(["pwd"]), context)),
    );
    assert(parallel.every((result) => result.exit_code === 0 && result.stdout.trim() === "/tmp"));
    const python = await executor.executeShell(quote(["python3", "-c", "print(6 * 7)"]), context);
    assert.equal(python.exit_code, 0);
    assert.equal(python.stdout.trim(), "42");
    const longerCommand = await executor.executeShell(quote(["sleep", "31"]), context);
    assert.equal(longerCommand.exit_code, 0, JSON.stringify(longerCommand));

    const script = "cat > /tmp/server.py <<'EOF'\nprint('sandbox file')\nEOF";
    const written = await executor.executeShell(script, context);
    assert.equal(written.exit_code, 0, JSON.stringify(written));
    const compiled = await executor.executeShell(
      quote(["python3", "-m", "py_compile", "/tmp/server.py"]),
      context,
    );
    assert.equal(compiled.exit_code, 0, JSON.stringify(compiled));
    const scriptAgent = {
      id: "coder",
      commandTarget: "sandbox",
      app: createAgent({
        model: new ScriptedShellModel({}),
        tools: [createCommandTool(executor)],
        checkpointer: new MemorySaver(),
      }),
    };
    const approvedScript = "cat > /tmp/approved.py <<'EOF'\nprint('approved')\nEOF";
    const pendingTurn = await startTurn(scriptAgent, approvedScript, threadId, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(pendingTurn.kind, "paused");
    assert.equal(
      (await executor.executeShell(quote(["test", "!", "-e", "/tmp/approved.py"]), context))
        .exit_code,
      0,
    );
    const approvals = await getPendingApprovals(scriptAgent, threadId);
    assert.equal(approvals[0].target, "sandbox");
    const completedTurn = await resumeTurn(scriptAgent, { [approvals[0].id]: true }, threadId, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(JSON.parse(completedTurn.text).exit_code, 0);
    const agentCommand = async (command) => {
      const turn = await startTurn(scriptAgent, command, threadId, {
        signal: AbortSignal.timeout(15_000),
      });
      if (turn.kind !== "paused") return turn;
      const pending = await getPendingApprovals(scriptAgent, threadId);
      return resumeTurn(scriptAgent, { [pending[0].id]: true }, threadId, {
        signal: AbortSignal.timeout(15_000),
      });
    };
    assert.equal(
      JSON.parse((await agentCommand("export WINGMAN_AGENT_STATE=shared")).text).exit_code,
      0,
    );
    const agentResult = JSON.parse((await agentCommand('printf "%s" "$WINGMAN_AGENT_STATE"')).text);
    assert.equal(agentResult.stdout.trim(), "shared");
    assert.equal(
      (
        await executor.executeShell(
          quote(["python3", "-m", "py_compile", "/tmp/approved.py"]),
          context,
        )
      ).exit_code,
      0,
    );
    let resolveFirst;
    const firstChunk = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let output = "";
    const subscription = await executor.subscribeEvents(threadId, null, ({ text }) => {
      output += text;
      if (text.includes("first")) resolveFirst();
    });
    let completed = false;
    const streamed = executor
      .executeShell(
        quote([
          "python3",
          "-u",
          "-c",
          "import time; print('first', flush=True); time.sleep(1); print('second')",
        ]),
        context,
      )
      .then((value) => {
        completed = true;
        return value;
      });
    await Promise.race([
      firstChunk,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Live output did not arrive")), 5000),
      ),
    ]);
    assert.equal(completed, false);
    assert.equal((await streamed).exit_code, 0);
    assert.match(output, /first/);
    assert.match(output, /second/);
    subscription.unsubscribe();
    assert.equal(
      (await executor.list()).find((item) => item.threadId === threadId)?.status,
      "running",
    );
    assert.equal(
      (await executor.executeShell(quote(["touch", "/tmp/wingman-test"]), context)).exit_code,
      0,
    );
    assert.equal(
      (await executor.executeShell(quote(["test", "-f", "/tmp/wingman-test"]), context)).exit_code,
      0,
    );
    assert.notEqual(
      (await executor.executeShell(quote(["touch", "/etc/wingman-test"]), context)).exit_code,
      0,
    );
    const env = await executor.executeShell(quote(["env"]), context);
    assert(!env.stdout.includes("POSTGRES_CONNECTION_STRING="));
    const result = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [threadId],
    );
    assert.match(result.rows[0].container_id, /^[a-f0-9]{64}$/);
    const container = JSON.parse(
      execFileSync("docker", ["inspect", result.rows[0].container_id], { encoding: "utf8" }),
    )[0];
    const networkId = container.HostConfig.NetworkMode;
    assert.match(networkId, /^[a-f0-9]{64}$/);
    const network = JSON.parse(
      execFileSync("docker", ["network", "inspect", networkId], { encoding: "utf8" }),
    )[0];
    assert.equal(network.Driver, "bridge");
    assert.equal(Object.keys(network.Containers).length, 1);
    assert.equal(
      (await executor.executeShell(quote(["pwd"]), { ...context, threadId: missingThreadId }))
        .exit_code,
      0,
    );
    const otherRecord = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    const otherContainer = JSON.parse(
      execFileSync("docker", ["inspect", otherRecord.rows[0].container_id], { encoding: "utf8" }),
    )[0];
    assert.notEqual(otherContainer.HostConfig.NetworkMode, networkId);

    const pinnedTag = `wingman-sandbox:sha256-${container.Image.slice("sha256:".length)}`;
    const pinnedImageId = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", pinnedTag],
      { encoding: "utf8" },
    ).trim();
    assert.equal(pinnedImageId, container.Image);
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
    assert.equal(container.HostConfig.PidsLimit, 128);
    assert.deepEqual(container.HostConfig.Binds ?? [], []);
    await deleteThreadState(
      {
        app: { graph: { checkpointer: { async deleteThread() {} } } },
        async deleteDelegatedState() {},
        releaseConversation: (id) => executor.release(id),
      },
      threadId,
    );
    const removed = await admin.query(
      `SELECT 1 FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [threadId],
    );
    assert.equal(removed.rowCount, 0);
    assert.throws(() =>
      execFileSync("docker", ["inspect", result.rows[0].container_id], { stdio: "pipe" }),
    );
    assert.throws(() =>
      execFileSync("docker", ["network", "inspect", networkId], { stdio: "pipe" }),
    );
    const newConversation = await executor.executeShell(quote(["pwd"]), {
      ...context,
      threadId: nextThreadId,
    });
    assert.equal(newConversation.exit_code, 0, JSON.stringify(newConversation));
    assert.equal(newConversation.stdout.trim(), "/tmp");
    const nextContext = { ...context, threadId: nextThreadId };
    assert.equal(
      (await executor.executeShell(quote(["touch", "/tmp/before-stop"]), nextContext)).exit_code,
      0,
    );
    assert.equal(await executor.stop(nextThreadId), true);
    assert.equal(
      (await executor.list()).find((item) => item.threadId === nextThreadId)?.status,
      "stopped",
    );
    const afterStop = await executor.executeShell(
      quote(["test", "-f", "/tmp/before-stop"]),
      nextContext,
    );
    assert.equal(afterStop.exit_code, 1);
    assert.match(afterStop.warning, /restarted.*temporary files were lost/i);
    await executor.release(nextThreadId);
    assert.equal(
      (await executor.list()).some((item) => item.threadId === nextThreadId),
      false,
    );

    const missingContext = { ...context, threadId: missingThreadId };
    const initialMissingContainer = await executor.executeShell(quote(["pwd"]), missingContext);
    assert.equal(initialMissingContainer.exit_code, 0, JSON.stringify(initialMissingContainer));
    const missingRecord = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    execFileSync("docker", ["rm", "--force", missingRecord.rows[0].container_id]);
    const missing = await executor.executeShell(quote(["date"]), missingContext);
    assert.equal(missing.exit_code, 0);
    assert.match(missing.warning, /missing.*replacement.*files are unavailable/i);
    const replacement = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    assert.notEqual(replacement.rows[0].container_id, missingRecord.rows[0].container_id);
    assert.equal((await executor.executeShell(quote(["pwd"]), missingContext)).warning, undefined);
    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET recovery_reason='missing' WHERE thread_id=$1`,
      [missingThreadId],
    );
    assert.match(
      (await executor.executeShell(quote(["pwd"]), missingContext)).warning,
      /missing.*replacement/i,
    );
    assert.equal((await executor.executeShell(quote(["pwd"]), missingContext)).warning, undefined);
    execFileSync("docker", ["rm", "--force", replacement.rows[0].container_id]);
    const recovered = await Promise.all(
      Array.from({ length: 12 }, () => executor.executeShell(quote(["pwd"]), missingContext)),
    );
    assert(recovered.every((value) => value.exit_code === 0));
    assert(recovered.some((value) => /missing.*replacement/i.test(value.warning ?? "")));
    const recoveredRows = await admin.query(
      `SELECT container_id, owner_token FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    assert.notEqual(recoveredRows.rows[0].container_id, replacement.rows[0].container_id);
    const owned = execFileSync(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=io.wingman.owner=${recoveredRows.rows[0].owner_token}`,
        "--format",
        "{{.ID}}",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.equal(owned.length, 1);
  },
);

test(
  "sandbox lifecycle retains across restart, expires idle workspaces, and can stop on shutdown",
  { timeout: 180_000 },
  async (t) => {
    const schema = `docker_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const dir = new URL("../../sandbox", import.meta.url).pathname;
    const first = new DockerCommandExecutor(scopedUrl.toString(), dir, { idleTimeoutHours: 1 });
    let current = first;
    const threadId = `integration-${randomUUID()}`;
    const startupThreadId = `integration-${randomUUID()}`;
    const context = { threadId, target: "sandbox", cwd: "/tmp" };
    t.after(async () => {
      await current.release(threadId);
      await current.release(startupThreadId);
      await current.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await first.init();
    assert.equal(
      (await first.executeShell(quote(["touch", "/tmp/preserved"]), context)).exit_code,
      0,
    );
    const before = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [threadId],
    );
    await first.close();
    current = new DockerCommandExecutor(scopedUrl.toString(), dir, { idleTimeoutHours: 1 });
    await current.init();
    assert.equal(
      (await current.executeShell(quote(["test", "-f", "/tmp/preserved"]), context)).exit_code,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
          [threadId],
        )
      ).rows[0].container_id,
      before.rows[0].container_id,
    );

    const running = current.executeShell(quote(["sleep", "2"]), context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET last_used_at=now()-interval '2 hours' WHERE thread_id=$1`,
      [threadId],
    );
    await current.expireIdle();
    assert.equal((await running).exit_code, 0);
    assert.equal(
      (await current.executeShell(quote(["test", "-f", "/tmp/preserved"]), context)).exit_code,
      0,
    );

    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET last_used_at=now()-interval '2 hours' WHERE thread_id=$1`,
      [threadId],
    );
    await current.expireIdle();
    assert.throws(() =>
      execFileSync("docker", ["inspect", before.rows[0].container_id], { stdio: "pipe" }),
    );
    const expired = await current.executeShell(quote(["pwd"]), context);
    assert.equal(expired.exit_code, 0, JSON.stringify(expired));
    assert.match(expired.warning, /expired.*replacement.*files are unavailable/i);
    const startupContext = { ...context, threadId: startupThreadId };
    assert.equal((await current.executeShell(quote(["pwd"]), startupContext)).exit_code, 0);
    const startupRecord = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [startupThreadId],
    );
    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET last_used_at=now()-interval '2 hours' WHERE thread_id=$1`,
      [startupThreadId],
    );
    await current.close();
    current = new DockerCommandExecutor(scopedUrl.toString(), dir, { idleTimeoutHours: 1 });
    await current.init();
    assert.throws(() =>
      execFileSync("docker", ["inspect", startupRecord.rows[0].container_id], { stdio: "pipe" }),
    );
    assert.match(
      (await current.executeShell(quote(["pwd"]), startupContext)).warning,
      /expired.*replacement/i,
    );
  },
);

test("stop shutdown stops the conversation container", { timeout: 180_000 }, async (t) => {
  const schema = `docker_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const dir = new URL("../../sandbox", import.meta.url).pathname;
  const executor = new DockerCommandExecutor(scopedUrl.toString(), dir, { shutdownAction: "stop" });
  let cleanup;
  const threadId = `integration-${randomUUID()}`;
  t.after(async () => {
    if (!cleanup) {
      cleanup = new DockerCommandExecutor(scopedUrl.toString(), dir);
      await cleanup.init();
    }
    await cleanup.release(threadId);
    await cleanup.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await executor.init();
  assert.equal(
    (await executor.executeShell(quote(["pwd"]), { threadId, target: "sandbox", cwd: "/tmp" }))
      .exit_code,
    0,
  );
  assert.equal(
    (
      await executor.executeShell(quote(["touch", "/tmp/before-stop"]), {
        threadId,
        target: "sandbox",
        cwd: "/tmp",
      })
    ).exit_code,
    0,
  );
  const { rows } = await admin.query(
    `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
    [threadId],
  );
  await executor.close();
  const state = JSON.parse(
    execFileSync("docker", ["inspect", rows[0].container_id], { encoding: "utf8" }),
  )[0].State;
  assert.equal(state.Running, false);
  cleanup = new DockerCommandExecutor(scopedUrl.toString(), dir);
  await cleanup.init();
  const restarted = await cleanup.executeShell(quote(["test", "-f", "/tmp/before-stop"]), {
    threadId,
    target: "sandbox",
    cwd: "/tmp",
  });
  assert.equal(restarted.exit_code, 1);
  assert.match(restarted.warning, /restarted.*temporary files were lost/i);
  const restartedContainer = JSON.parse(
    execFileSync("docker", ["inspect", rows[0].container_id], { encoding: "utf8" }),
  )[0];
  assert.equal(restartedContainer.State.Running, true);
  assert.equal(restartedContainer.Id, rows[0].container_id);
});

test("commands in one sandbox do not run concurrently", { timeout: 180_000 }, async (t) => {
  const schema = `docker_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const executor = new DockerCommandExecutor(
    scopedUrl.toString(),
    new URL("../../sandbox", import.meta.url).pathname,
  );
  const threadId = `integration-${randomUUID()}`;
  t.after(async () => {
    await executor.release(threadId);
    await executor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await executor.init();
  const context = { threadId, target: "sandbox", cwd: "/tmp" };
  const results = await Promise.all([
    executor.executeShell("mkdir /tmp/active && sleep 1 && rmdir /tmp/active", context),
    executor.executeShell("mkdir /tmp/active && sleep 1 && rmdir /tmp/active", context),
  ]);
  assert(
    results.every((result) => result.exit_code === 0),
    JSON.stringify(results),
  );
});

test("commands in different sandboxes can run concurrently", { timeout: 180_000 }, async (t) => {
  const schema = `docker_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const executor = new DockerCommandExecutor(
    scopedUrl.toString(),
    new URL("../../sandbox", import.meta.url).pathname,
  );
  const threads = [`integration-${randomUUID()}`, `integration-${randomUUID()}`];
  const contexts = threads.map((threadId) => ({ threadId, target: "sandbox", cwd: "/tmp" }));
  t.after(async () => {
    for (const threadId of threads) await executor.release(threadId);
    await executor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await executor.init();
  for (const context of contexts) {
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
  }
  let started = 0;
  let finished = 0;
  let overlap = false;
  const subscriptions = await Promise.all(
    threads.map((threadId) =>
      executor.subscribeEvents(threadId, null, ({ text }) => {
        if (text.includes("[Command started]")) {
          started++;
          if (started === 2 && finished === 0) overlap = true;
        }
        if (text.includes("[Command completed]")) finished++;
      }),
    ),
  );
  try {
    const results = await Promise.all(
      contexts.map((context) => executor.executeShell(quote(["sleep", "1"]), context)),
    );
    assert(
      results.every((result) => result.exit_code === 0),
      JSON.stringify(results),
    );
    assert.equal(overlap, true, "commands should be running concurrently in separate sandboxes");
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
  }
});

test("sandbox image supports a persistent PTY session", { timeout: 180_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const schema = `docker_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const executor = new DockerCommandExecutor(
    scopedUrl.toString(),
    new URL("../../sandbox", import.meta.url).pathname,
  );
  const threadId = `integration-${randomUUID()}`;
  let child;
  t.after(async () => {
    child?.kill();
    await executor.release(threadId);
    await executor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await executor.init();
  assert.equal(
    (await executor.executeShell(quote(["pwd"]), { threadId, target: "sandbox", cwd: "/tmp" }))
      .exit_code,
    0,
  );
  const context = { threadId, target: "sandbox", cwd: "/tmp" };
  assert.equal(
    (await executor.executeShell("cd /; export WINGMAN_SESSION=shared", context)).exit_code,
    0,
  );
  const carried = await executor.executeShell('printf "%s:%s" "$PWD" "$WINGMAN_SESSION"', context);
  assert.equal(carried.stdout.trim(), "/:shared");
  const sandbox = (await executor.list()).find((item) => item.threadId === threadId);
  assert(sandbox?.containerId);
  child = spawn(
    "docker",
    ["exec", "-i", sandbox.containerId, "node", "/usr/local/lib/wingman/pty-supervisor.cjs"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const events = [];
  let wake;
  createInterface({ input: child.stdout }).on("line", (line) => {
    events.push(JSON.parse(line));
    wake?.();
  });
  const waitFor = async (predicate) => {
    while (!events.some(predicate)) {
      await new Promise((resolve, reject) => {
        const onExit = (code) => reject(new Error(`PTY supervisor exited: ${code}`));
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
  assert.equal((await run("first", "cd /; export WINGMAN_TEST=retained")).exitCode, 0);
  assert.equal(
    (await run("second", 'printf \'%s:%s\\n\' "$PWD" "$WINGMAN_TEST"; test -t 1')).exitCode,
    0,
  );
  assert(
    events.some((event) => event.type === "command.output" && event.text.includes("/:retained")),
  );
  child.stdin.end(`${JSON.stringify({ type: "close" })}\n`);
  await new Promise((resolve) => child.once("close", resolve));
  const output = [];
  const session = new PtySession(sandbox.containerId, (text) => output.push(text));
  try {
    assert.equal((await session.execute("cd /; export WINGMAN_ADAPTER=present")).exit_code, 0);
    const second = await session.execute(`printf '%s:%s' "$PWD" "$WINGMAN_ADAPTER"`);
    assert.equal(second.exit_code, 0);
    assert.match(second.stdout, /\/:present/);
    assert(output.join("").includes("/:present"));
  } finally {
    await session.close();
  }
});

test(
  "interrupted PTY commands block further execution until the sandbox is reset",
  { timeout: 180_000 },
  async (t) => {
    const schema = `docker_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const executor = new DockerCommandExecutor(
      scopedUrl.toString(),
      new URL("../../sandbox", import.meta.url).pathname,
    );
    const threadId = `integration-${randomUUID()}`;
    t.after(async () => {
      await executor.release(threadId);
      await executor.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await executor.init();
    const context = { threadId, target: "sandbox", cwd: "/tmp" };
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    const controller = new AbortController();
    let markReady;
    let commandOutput = "";
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const subscription = await executor.subscribeEvents(threadId, null, ({ text, kind }) => {
      if (kind !== "output") return;
      commandOutput += text;
      if (/PID=\d+/.test(commandOutput)) markReady();
    });
    const running = executor.executeShell("sh -c 'echo PID=$$; exec sleep 30'", {
      ...context,
      signal: controller.signal,
    });
    await ready;
    const commandPid = commandOutput.match(/PID=(\d+)/)[1];
    assert.equal(
      (await executor.list()).find((item) => item.threadId === threadId)?.sessionStatus,
      "running",
    );
    controller.abort();
    const result = await running;
    subscription.unsubscribe();
    assert.equal(result.failure, "transport_error");
    assert.match(result.error, /uncertain/i);
    const sandbox = (await executor.list()).find((item) => item.threadId === threadId);
    assert.equal(sandbox?.sessionStatus, "needs_reset");
    assert.throws(() =>
      execFileSync("docker", ["exec", sandbox.containerId, "kill", "-0", commandPid], {
        stdio: "pipe",
      }),
    );
    const blocked = await executor.executeShell(quote(["pwd"]), context);
    assert.equal(blocked.failure, "sandbox_unavailable");
    assert.match(blocked.error, /uncertain.*stop or remove/i);
    assert.equal(await executor.stop(threadId), true);
    const restarted = await executor.executeShell(quote(["pwd"]), context);
    assert.equal(restarted.exit_code, 0);
    assert.match(restarted.warning, /shell state/i);
  },
);

test("only one server runtime owns a conversation PTY session", { timeout: 180_000 }, async (t) => {
  const schema = `docker_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const dir = new URL("../../sandbox", import.meta.url).pathname;
  const first = new DockerCommandExecutor(scopedUrl.toString(), dir);
  const second = new DockerCommandExecutor(scopedUrl.toString(), dir);
  const threadId = `integration-${randomUUID()}`;
  let firstClosed = false;
  t.after(async () => {
    if (!firstClosed) await first.close();
    await second.release(threadId);
    await second.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await first.init();
  await second.init();
  const context = { threadId, target: "sandbox", cwd: "/tmp" };
  assert.equal((await first.executeShell("export WINGMAN_OWNER=first", context)).exit_code, 0);
  assert.equal(
    (await first.list()).find((item) => item.threadId === threadId)?.sessionStatus,
    "ready",
  );
  assert.equal(
    (await second.list()).find((item) => item.threadId === threadId)?.sessionStatus,
    "remote",
  );
  const denied = await second.executeShell(quote(["pwd"]), context);
  assert.equal(denied.failure, "sandbox_unavailable");
  await first.close();
  firstClosed = true;
  const recovered = await second.executeShell('printf "%s" "${WINGMAN_OWNER:-fresh}"', context);
  assert.equal(recovered.exit_code, 0);
  assert.equal(recovered.stdout.trim(), "fresh");
  assert.match(recovered.warning, /shell session restarted/i);
});

test(
  "sandbox names survive migration, container replacement and removal",
  { timeout: 180_000 },
  async (t) => {
    const schema = `docker_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".wingman_docker_sessions (
    thread_id TEXT PRIMARY KEY,
    container_name TEXT NOT NULL UNIQUE,
    owner_token UUID NOT NULL,
    container_id TEXT UNIQUE
  )`);
    const threadId = `integration-${randomUUID()}`;
    await admin.query(
      `INSERT INTO "${schema}".wingman_docker_sessions (thread_id, container_name, owner_token) VALUES ($1, $2, $3)`,
      [threadId, `wingman-${randomUUID()}`, randomUUID()],
    );
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const executor = new DockerCommandExecutor(
      scopedUrl.toString(),
      new URL("../../sandbox", import.meta.url).pathname,
    );
    t.after(async () => {
      await executor.release(threadId);
      await executor.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await executor.init();
    const migrated = (await executor.list()).find((item) => item.threadId === threadId);
    assert.match(migrated.name, /^[A-Z][a-z]+-[a-f0-9]{12}$/);
    const context = { threadId, target: "sandbox", cwd: "/tmp" };
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    const initial = (await executor.list()).find((item) => item.threadId === threadId);
    assert.equal(initial.name, migrated.name);
    assert.ok(initial.containerId);
    execFileSync("docker", ["rm", "--force", initial.containerId]);
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    const replacement = (await executor.list()).find((item) => item.threadId === threadId);
    assert.equal(replacement.name, initial.name);
    assert.notEqual(replacement.containerId, initial.containerId);
    await executor.release(threadId);
    assert.equal((await executor.executeShell(quote(["pwd"]), context)).exit_code, 0);
    const recreated = (await executor.list()).find((item) => item.threadId === threadId);
    assert.equal(recreated.name, initial.name);
    assert.notEqual(recreated.containerId, replacement.containerId);
  },
);
