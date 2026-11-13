import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { bashTools, createCommandTool } from "../src/capabilities/commands.ts";
import { createOrchestratorAgentDefinition } from "../src/agents/builtins/index.ts";
import { buildSystemPrompt } from "../src/agents/prompt.ts";
import { startTurn, resumeTurn, getPendingApprovals } from "../src/conversations/turn.ts";

// Script only the model's choice to call the tool. The production shell tool,
// graph, checkpoints, approval interrupts and execution all remain real.
class ShellModel extends BaseChatModel {
  _llmType() {
    return "shell-approval-test";
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const index = messages.findLastIndex(HumanMessage.isInstance);
    const result = messages.slice(index + 1).find(ToolMessage.isInstance);
    const message = result
      ? new AIMessage(result.text)
      : new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "exec_bash_command",
              args: { command: messages[index].text },
              id: `shell-${index}`,
              type: "tool_call",
            },
          ],
        });
    return { generations: [{ text: message.text, message }] };
  }
}

function agent(tools = bashTools) {
  return {
    id: "orchestrator",
    app: createAgent({
      model: new ShellModel({}),
      tools,
      checkpointer: new MemorySaver(),
      systemPrompt: buildSystemPrompt({
        definition: createOrchestratorAgentDefinition(),
        toolNames: ["exec_bash_command"],
        memoryIndex: "",
        skillIndex: "",
      }),
    }),
  };
}

const options = () => ({ signal: AbortSignal.timeout(10_000) });

test("system instructions distinguish blocked commands from explicit retries after decline", () => {
  const prompt = buildSystemPrompt({
    definition: createOrchestratorAgentDefinition(),
    toolNames: ["exec_bash_command"],
    memoryIndex: "",
    skillIndex: "",
  });
  assert.match(prompt, /blocked[^\n]*never retry/i);
  assert.match(prompt, /declines[^\n]*on your own/i);
  assert.match(prompt, /explicitly asks[^\n]*again[^\n]*approval/i);
  assert.match(prompt, /command result includes a warning[^\n]*report it clearly/i);
});

test(
  "a declined shell attempt can be requested again, but every attempt needs fresh approval",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "wingman-shell-retry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "executions.txt");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'executed\\n')`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const harness = agent();
    const ids = new Set();

    for (const approve of [false, false, true]) {
      const paused = await startTurn(harness, command, "retry", options());
      assert.equal(paused.kind, "paused");
      const pending = await getPendingApprovals(harness, "retry");
      assert.equal(pending.length, 1);
      assert.equal(pending[0].command, command);
      assert.ok(!ids.has(pending[0].id), "a retry must not reuse an old approval");
      ids.add(pending[0].id);
      await assert.rejects(readFile(output), { code: "ENOENT" });
      const result = await resumeTurn(harness, { [pending[0].id]: approve }, "retry", options());
      assert.equal(result.kind, "done");
      const response = JSON.parse(result.text);
      if (!approve) {
        assert.match(response.error, /on your own/i);
        assert.match(response.error, /explicitly asks[^.]*again/i);
        assert.match(response.error, /approval/i);
        await assert.rejects(readFile(output), { code: "ENOENT" });
      } else {
        assert.equal(response.exit_code, 0);
        assert.equal(await readFile(output, "utf8"), "executed\n");
      }
      assert.deepEqual(await getPendingApprovals(harness, "retry"), []);
    }
  },
);

test("blocked commands remain blocked across fresh user requests without offering approval", async () => {
  const harness = agent();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await startTurn(harness, "rm --help", "blocked", options());
    assert.equal(result.kind, "done");
    assert.match(JSON.parse(result.text).error, /Blocked:.*Don't retry/);
    assert.deepEqual(await getPendingApprovals(harness, "blocked"), []);
  }
});

test("sandbox shell scripts require approval and execute the exact script only in the sandbox", async () => {
  const calls = [];
  const executor = {
    target: "sandbox",
    async execute() {
      assert.fail("sandbox scripts must use the sandbox shell");
    },
    async executeShell(script, context) {
      calls.push({ script, context });
      return { stdout: "saved", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
  harness.commandTarget = "sandbox";
  const script = "cat <<'EOF' > /tmp/server.py\nprint('hello')\nEOF";
  const paused = await startTurn(harness, script, "sandbox-script", options());
  assert.equal(paused.kind, "paused");
  assert.equal(calls.length, 0);
  const pending = await getPendingApprovals(harness, "sandbox-script");
  assert.equal(pending[0].command, script);
  assert.equal(pending[0].target, "sandbox");
  await resumeTurn(harness, { [pending[0].id]: true }, "sandbox-script", options());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, script);
  assert.equal(calls[0].context.target, "sandbox");

  const host = agent();
  const rejected = await startTurn(host, script, "host-script", options());
  assert.equal(rejected.kind, "done");
  assert.match(JSON.parse(rejected.text).error, /shell syntax/i);
  assert.deepEqual(await getPendingApprovals(host, "host-script"), []);
});

test("declining a sandbox shell script never executes it", async () => {
  let executed = false;
  const harness = agent([
    createCommandTool({
      target: "sandbox",
      async execute() {
        assert.fail();
      },
      async executeShell() {
        executed = true;
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ]);
  harness.commandTarget = "sandbox";
  const paused = await startTurn(harness, "echo hello > /tmp/example", "sandbox-denial", options());
  assert.equal(paused.kind, "paused");
  const pending = await getPendingApprovals(harness, "sandbox-denial");
  await resumeTurn(harness, { [pending[0].id]: false }, "sandbox-denial", options());
  assert.equal(executed, false);
});

test("sandbox expansions and compound commands never inherit a safe command's automatic approval", async () => {
  const calls = [];
  const harness = agent([
    createCommandTool({
      target: "sandbox",
      async execute() {
        assert.fail();
      },
      async executeShell(script) {
        calls.push(script);
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ]);
  harness.commandTarget = "sandbox";
  for (const [index, script] of ["ls $HOME", "pwd\necho changed", "pwd; echo changed"].entries()) {
    const thread = `sandbox-expansion-${index}`;
    const paused = await startTurn(harness, script, thread, options());
    assert.equal(paused.kind, "paused", script);
    const pending = await getPendingApprovals(harness, thread);
    await resumeTurn(harness, { [pending[0].id]: false }, thread, options());
  }
  assert.deepEqual(calls, []);
});

test("a pending sandbox script cannot execute after switching to the host target", async () => {
  let executed = false;
  const harness = agent([
    createCommandTool({
      target: "sandbox",
      async execute() {
        assert.fail();
      },
      async executeShell() {
        executed = true;
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ]);
  harness.commandTarget = "sandbox";
  const paused = await startTurn(
    harness,
    "echo hello > /tmp/example",
    "sandbox-target-change",
    options(),
  );
  assert.equal(paused.kind, "paused");
  const pending = await getPendingApprovals(harness, "sandbox-target-change");
  harness.commandTarget = "host";
  await assert.rejects(
    resumeTurn(harness, { [pending[0].id]: true }, "sandbox-target-change", options()),
    /target changed/,
  );
  assert.equal(executed, false);
});

test("trusted executor receives argv and context only after command approval", async () => {
  const calls = [];
  const executor = {
    target: "host",
    async execute(argv, context) {
      calls.push({ argv, context });
      return { stdout: "from executor", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
  const threadId = "executor-test";
  const first = await startTurn(harness, "echo hello", threadId, options());
  assert.equal(first.kind, "paused");
  assert.equal(calls.length, 0);
  const pending = await getPendingApprovals(harness, threadId);
  const resumed = await resumeTurn(harness, { [pending[0].id]: true }, threadId, options());
  assert.equal(resumed.kind, "done");
  assert.deepEqual(calls[0].argv, ["echo", "hello"]);
  assert.equal(calls[0].context.threadId, threadId);
  assert.equal(calls[0].context.target, "host");
  assert.match(resumed.text, /from executor/);
});

test("delegated commands use the originating conversation identity", async () => {
  const calls = [];
  const executor = {
    target: "sandbox",
    async execute(argv, context) {
      calls.push({ argv, context });
      return { stdout: "sandbox", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
  harness.commandTarget = "sandbox";
  const threadId = "child-checkpoint";
  const first = await startTurn(harness, "echo hello", threadId, {
    ...options(),
    conversationId: "originating-conversation",
  });
  assert.equal(first.kind, "paused");
  const pending = await getPendingApprovals(harness, threadId);
  await resumeTurn(harness, { [pending[0].id]: true }, threadId, {
    ...options(),
    conversationId: "originating-conversation",
  });
  assert.equal(calls[0].context.threadId, "originating-conversation");
  assert.equal(calls[0].context.target, "sandbox");
});

test("a pending sandbox approval cannot authorize host execution after a target change", async () => {
  let executions = 0;
  const executor = {
    target: "sandbox",
    async execute() {
      executions++;
      return { stdout: "", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
  harness.commandTarget = "sandbox";
  await startTurn(harness, "echo hello", "target-change", options());
  const pending = await getPendingApprovals(harness, "target-change");
  assert.equal(pending[0].target, "sandbox");
  harness.commandTarget = "host";
  await assert.rejects(
    resumeTurn(harness, { [pending[0].id]: true }, "target-change", options()),
    /target changed/,
  );
  assert.equal(executions, 0);
  assert.equal((await getPendingApprovals(harness, "target-change")).length, 1);
});
