import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { z } from "zod";

class ScriptedModel extends BaseChatModel {
  constructor(respond) { super({}); this.respond = respond; }
  _llmType() { return "delegation-checkpoint-spike"; }
  bindTools() { return this; }
  async _generate(messages) {
    const message = await this.respond(messages);
    return { generations: [{ text: message.text, message }] };
  }
}

test("nested tool can isolate child checkpoints and emit custom progress with stable tool identity", async () => {
  const saver = new MemorySaver();
  let calls = 0;
  const child = createAgent({ checkpointer: saver, tools: [], model: new ScriptedModel(messages => {
    calls++;
    assert.equal(messages.filter(HumanMessage.isInstance).length, 1);
    assert.equal(messages.filter(HumanMessage.isInstance)[0].text, "scoped context");
    return new AIMessage("child result");
  }) });
  const delegate = tool(async (_input, runtime) => {
    assert.equal(runtime.toolCallId, "delegate-1");
    assert.equal(runtime.state.messages.findLast(HumanMessage.isInstance).id, "parent-execution");
    runtime.writer?.({ type: "spike-progress" });
    const config = { configurable: { thread_id: "internal-child", checkpoint_ns: "", checkpoint_map: {} } };
    const result = await child.invoke({ messages: [new HumanMessage("scoped context")] }, config);
    return result.messages.at(-1).text;
  }, { name: "delegate", description: "Delegate scoped task", schema: z.object({}) });
  const parent = createAgent({ checkpointer: saver, tools: [delegate], model: new ScriptedModel(messages => {
    const result = messages.find(ToolMessage.isInstance);
    return result ? new AIMessage(`parent: ${result.text}`) : new AIMessage({ content: "", tool_calls: [{
      id: "delegate-1", name: "delegate", args: {}, type: "tool_call",
    }] });
  }) });
  const chunks = [];
  for await (const chunk of await parent.stream({ messages: [new HumanMessage({ id: "parent-execution", content: "private parent context" })] }, {
    configurable: { thread_id: "parent-chat" }, streamMode: ["updates", "custom"],
  })) chunks.push(chunk);
  assert.ok(chunks.some(([mode, value]) => mode === "custom" && value.type === "spike-progress"));
  const childState = await child.graph.getState({ configurable: { thread_id: "internal-child" } });
  assert.equal(childState.values.messages.at(-1).text, "child result");
  const parentState = await parent.graph.getState({ configurable: { thread_id: "parent-chat" } });
  assert.equal(parentState.values.messages.at(-1).text, "parent: child result");
  assert.equal(calls, 1);
  assert.ok(!childState.values.messages.some(message => message.text.includes("private parent context")));
});

test("a child interrupt is observable without executing its protected side effect", async () => {
  const sideEffects = [];
  const action = tool(async () => {
    interrupt({ kind: "approval" });
    sideEffects.push("executed");
    return "done";
  }, { name: "protected_action", description: "Protected action", schema: z.object({}) });
  const child = createAgent({ checkpointer: new MemorySaver(), tools: [action], model: new ScriptedModel(() =>
    new AIMessage({ content: "", tool_calls: [{ name: "protected_action", args: {}, id: "protected", type: "tool_call" }] }),
  ) });
  const chunks = [];
  for await (const update of await child.stream({ messages: [new HumanMessage("act")] }, {
    configurable: { thread_id: "interrupt-child" }, streamMode: "updates",
  })) chunks.push(update);
  assert.ok(chunks.some(update => update.__interrupt__?.length));
  assert.deepEqual(sideEffects, []);
});
