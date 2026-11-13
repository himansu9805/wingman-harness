import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import pg from "pg";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { DockerCommandExecutor } from "../../src/capabilities/execution/docker-command-executor.ts";
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
    const context = { threadId, target: "sandbox", cwd: "/private/host" };
    t.after(async () => {
      await executor.release(threadId);
      await executor.release(missingThreadId);
      await executor.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await executor.init();
    const pwd = await executor.execute(["pwd"], context);
    assert.equal(pwd.exit_code, 0);
    assert.equal(pwd.stdout.trim(), "/tmp");
    const parallel = await Promise.all(
      Array.from({ length: 12 }, () => executor.execute(["pwd"], context)),
    );
    assert(parallel.every((result) => result.exit_code === 0 && result.stdout.trim() === "/tmp"));
    const python = await executor.execute(["python3", "-c", "print(6 * 7)"], context);
    assert.equal(python.exit_code, 0);
    assert.equal(python.stdout.trim(), "42");
    const script = "cat > /tmp/server.py <<'EOF'\nprint('sandbox file')\nEOF";
    const written = await executor.executeShell(script, context);
    assert.equal(written.exit_code, 0, JSON.stringify(written));
    const compiled = await executor.execute(
      ["python3", "-m", "py_compile", "/tmp/server.py"],
      context,
    );
    assert.equal(compiled.exit_code, 0, JSON.stringify(compiled));
    const scriptAgent = {
      id: "operator",
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
      (await executor.execute(["test", "!", "-e", "/tmp/approved.py"], context)).exit_code,
      0,
    );
    const approvals = await getPendingApprovals(scriptAgent, threadId);
    assert.equal(approvals[0].target, "sandbox");
    const completedTurn = await resumeTurn(scriptAgent, { [approvals[0].id]: true }, threadId, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(JSON.parse(completedTurn.text).exit_code, 0);
    assert.equal(
      (await executor.execute(["python3", "-m", "py_compile", "/tmp/approved.py"], context))
        .exit_code,
      0,
    );
    let resolveFirst;
    const firstChunk = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let output = "";
    const subscription = await executor.subscribe(threadId, (text) => {
      output += text;
      if (text.includes("first")) resolveFirst();
    });
    let completed = false;
    const streamed = executor
      .execute(
        [
          "python3",
          "-u",
          "-c",
          "import time; print('first', flush=True); time.sleep(1); print('second')",
        ],
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
    assert.equal((await executor.execute(["touch", "/tmp/wingman-test"], context)).exit_code, 0);
    assert.equal(
      (await executor.execute(["test", "-f", "/tmp/wingman-test"], context)).exit_code,
      0,
    );
    assert.notEqual((await executor.execute(["touch", "/etc/wingman-test"], context)).exit_code, 0);
    const env = await executor.execute(["env"], context);
    assert(!env.stdout.includes("POSTGRES_CONNECTION_STRING="));
    const result = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [threadId],
    );
    assert.match(result.rows[0].container_id, /^[a-f0-9]{64}$/);
    const container = JSON.parse(
      execFileSync("docker", ["inspect", result.rows[0].container_id], { encoding: "utf8" }),
    )[0];
    assert.equal(container.HostConfig.NetworkMode, "none");
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
    const missingContext = { ...context, threadId: missingThreadId };
    const initialMissingContainer = await executor.execute(["pwd"], missingContext);
    assert.equal(initialMissingContainer.exit_code, 0, JSON.stringify(initialMissingContainer));
    const missingRecord = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    execFileSync("docker", ["rm", "--force", missingRecord.rows[0].container_id]);
    const missing = await executor.execute(["date"], missingContext);
    assert.equal(missing.exit_code, 0);
    assert.match(missing.warning, /missing.*replacement.*files are unavailable/i);
    const replacement = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [missingThreadId],
    );
    assert.notEqual(replacement.rows[0].container_id, missingRecord.rows[0].container_id);
    assert.equal((await executor.execute(["pwd"], missingContext)).warning, undefined);
    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET recovery_reason='missing' WHERE thread_id=$1`,
      [missingThreadId],
    );
    assert.match(
      (await executor.execute(["pwd"], missingContext)).warning,
      /missing.*replacement/i,
    );
    assert.equal((await executor.execute(["pwd"], missingContext)).warning, undefined);
    execFileSync("docker", ["rm", "--force", replacement.rows[0].container_id]);
    const recovered = await Promise.all(
      Array.from({ length: 12 }, () => executor.execute(["pwd"], missingContext)),
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
    assert.equal((await first.execute(["touch", "/tmp/preserved"], context)).exit_code, 0);
    const before = await admin.query(
      `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
      [threadId],
    );
    await first.close();
    current = new DockerCommandExecutor(scopedUrl.toString(), dir, { idleTimeoutHours: 1 });
    await current.init();
    assert.equal((await current.execute(["test", "-f", "/tmp/preserved"], context)).exit_code, 0);
    assert.equal(
      (
        await admin.query(
          `SELECT container_id FROM "${schema}".wingman_docker_sessions WHERE thread_id=$1`,
          [threadId],
        )
      ).rows[0].container_id,
      before.rows[0].container_id,
    );

    const running = current.execute(["sleep", "2"], context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET last_used_at=now()-interval '2 hours' WHERE thread_id=$1`,
      [threadId],
    );
    await current.expireIdle();
    assert.equal((await running).exit_code, 0);
    assert.equal((await current.execute(["test", "-f", "/tmp/preserved"], context)).exit_code, 0);

    await admin.query(
      `UPDATE "${schema}".wingman_docker_sessions SET last_used_at=now()-interval '2 hours' WHERE thread_id=$1`,
      [threadId],
    );
    await current.expireIdle();
    assert.throws(() =>
      execFileSync("docker", ["inspect", before.rows[0].container_id], { stdio: "pipe" }),
    );
    const expired = await current.execute(["pwd"], context);
    assert.equal(expired.exit_code, 0, JSON.stringify(expired));
    assert.match(expired.warning, /expired.*replacement.*files are unavailable/i);
    const startupContext = { ...context, threadId: startupThreadId };
    assert.equal((await current.execute(["pwd"], startupContext)).exit_code, 0);
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
    assert.match((await current.execute(["pwd"], startupContext)).warning, /expired.*replacement/i);
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
    (await executor.execute(["pwd"], { threadId, target: "sandbox", cwd: "/tmp" })).exit_code,
    0,
  );
  assert.equal(
    (
      await executor.execute(["touch", "/tmp/before-stop"], {
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
  const restarted = await cleanup.execute(["test", "-f", "/tmp/before-stop"], {
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
