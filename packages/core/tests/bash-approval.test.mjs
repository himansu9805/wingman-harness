import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { bashTools } from '../src/tools/bash.ts';
import { buildSystemPrompt } from '../src/core/prompt.ts';
import { startTurn, resumeTurn, getPendingApprovals } from '../src/core/turn.ts';

// Script only the model's choice to call the tool. The production shell tool,
// graph, checkpoints, approval interrupts and execution all remain real.
class ShellModel extends BaseChatModel {
  _llmType() { return 'shell-approval-test'; }
  bindTools() { return this; }
  async _generate(messages) {
    const index = messages.findLastIndex(HumanMessage.isInstance);
    const result = messages.slice(index + 1).find(ToolMessage.isInstance);
    const message = result
      ? new AIMessage(result.text)
      : new AIMessage({ content: '', tool_calls: [{ name: 'exec_bash_command', args: { command: messages[index].text }, id: `shell-${index}`, type: 'tool_call' }] });
    return { generations: [{ text: message.text, message }] };
  }
}

function agent() {
  return { app: createAgent({ model: new ShellModel({}), tools: bashTools, checkpointer: new MemorySaver(), systemPrompt: buildSystemPrompt('', '') }) };
}

const options = () => ({ signal: AbortSignal.timeout(10_000) });

test('system instructions distinguish blocked commands from explicit retries after decline', () => {
  const prompt = buildSystemPrompt('', '');
  assert.match(prompt, /blocked[^\n]*never retry/i);
  assert.match(prompt, /declines[^\n]*on your own/i);
  assert.match(prompt, /explicitly asks[^\n]*again[^\n]*approval/i);
});

test('a declined shell attempt can be requested again, but every attempt needs fresh approval', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wingman-shell-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'executions.txt');
  const script = `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'executed\\n')`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const harness = agent();
  const ids = new Set();

  for (const approve of [false, false, true]) {
    const paused = await startTurn(harness, command, 'retry', options());
    assert.equal(paused.kind, 'paused');
    const pending = await getPendingApprovals(harness, 'retry');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].command, command);
    assert.ok(!ids.has(pending[0].id), 'a retry must not reuse an old approval');
    ids.add(pending[0].id);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    const result = await resumeTurn(harness, { [pending[0].id]: approve }, 'retry', options());
    assert.equal(result.kind, 'done');
    const response = JSON.parse(result.text);
    if (!approve) {
      assert.match(response.error, /on your own/i);
      assert.match(response.error, /explicitly asks[^.]*again/i);
      assert.match(response.error, /approval/i);
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } else {
      assert.equal(response.exit_code, 0);
      assert.equal(await readFile(output, 'utf8'), 'executed\n');
    }
    assert.deepEqual(await getPendingApprovals(harness, 'retry'), []);
  }
});

test('blocked commands remain blocked across fresh user requests without offering approval', async () => {
  const harness = agent();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await startTurn(harness, 'rm --help', 'blocked', options());
    assert.equal(result.kind, 'done');
    assert.match(JSON.parse(result.text).error, /Blocked:.*Don't retry/);
    assert.deepEqual(await getPendingApprovals(harness, 'blocked'), []);
  }
});
