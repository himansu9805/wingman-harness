import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { createCommandTool } from "../src/capabilities/commands.ts";
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

function agent(
  tools = [
    createCommandTool({
      target: "sandbox",
      async executeShell() {
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ],
) {
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
  assert.match(prompt, /declines[^\n]*on your own/i);
  assert.match(prompt, /explicitly asks[^\n]*again[^\n]*approval/i);
  assert.match(prompt, /command result includes a warning[^\n]*report it clearly/i);
});

test("a declined command needs fresh approval for each retry", async () => {
  const calls = [];
  const executor = {
    target: "sandbox",
    async executeShell(command) {
      calls.push(command);
      return { stdout: "executed", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
  const ids = new Set();
  for (const approve of [false, false, true]) {
    const paused = await startTurn(harness, "echo hello", "retry", options());
    assert.equal(paused.kind, "paused");
    const pending = await getPendingApprovals(harness, "retry");
    assert.equal(pending[0].target, "sandbox");
    assert.ok(!ids.has(pending[0].id));
    ids.add(pending[0].id);
    const result = await resumeTurn(harness, { [pending[0].id]: approve }, "retry", options());
    assert.equal(result.kind, "done");
    if (approve) assert.deepEqual(calls, ["echo hello"]);
    else {
      assert.match(JSON.parse(result.text).error, /explicitly asks[^.]*again/i);
      assert.deepEqual(calls, []);
    }
  }
});

test("sandbox shell scripts require approval and execute the exact script only in the sandbox", async () => {
  const calls = [];
  const executor = {
    target: "sandbox",
    async executeShell(script, context) {
      calls.push({ script, context });
      return { stdout: "saved", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
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
});

test("declining a sandbox shell script never executes it", async () => {
  let executed = false;
  const harness = agent([
    createCommandTool({
      target: "sandbox",
      async executeShell() {
        executed = true;
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ]);
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
      async executeShell(script) {
        calls.push(script);
        return { stdout: "", stderr: "", exit_code: 0 };
      },
    }),
  ]);
  for (const [index, script] of ["ls $HOME", "pwd\necho changed", "pwd; echo changed"].entries()) {
    const thread = `sandbox-expansion-${index}`;
    const paused = await startTurn(harness, script, thread, options());
    assert.equal(paused.kind, "paused", script);
    const pending = await getPendingApprovals(harness, thread);
    await resumeTurn(harness, { [pending[0].id]: false }, thread, options());
  }
  assert.deepEqual(calls, []);
});

test("sandbox executors must provide persistent shell execution", () => {
  assert.throws(
    () => createCommandTool({ target: "sandbox", execute: async () => ({}) }),
    /requires a persistent shell executor/,
  );
});

test("delegated commands use the originating conversation identity", async () => {
  const calls = [];
  const executor = {
    target: "sandbox",
    async executeShell(command, context) {
      calls.push({ command, context });
      return { stdout: "sandbox", stderr: "", exit_code: 0 };
    },
  };
  const harness = agent([createCommandTool(executor)]);
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
