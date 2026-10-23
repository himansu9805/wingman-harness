import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { createApprovalAgent } from '../../../tests/fixtures/approval-agent.mjs';
import { getThreadMessages, deleteThreadState } from '../src/core/history.ts';
import { previewToolOutput } from '../src/core/tool-output.ts';
import { startTurn, resumeTurn, getPendingApprovals } from '../src/core/turn.ts';

const opts = () => ({ signal: new AbortController().signal });
const call = (id) => ({ id, name: 'action', args: { command: id }, type: 'tool_call' });

test('history filters internal messages, preserves original ids/indexes and matches out-of-order results', async () => {
  const messages = [
    new SystemMessage('secret'),
    new HumanMessage({ id: 'user-id', content: [{ type: 'text', text: 'hello' }] }),
    new AIMessage({ content: '', tool_calls: [call('a'), call('b'), call('pending')] }),
    new ToolMessage({ content: 'second', tool_call_id: 'b' }),
    new ToolMessage({ content: 'first', tool_call_id: 'a' }),
    new AIMessage({ id: 'answer-id', content: 'done' }),
  ];
  const agent = { app: { graph: { async getState(config) {
    assert.deepEqual(config, { configurable: { thread_id: 'thread', checkpoint_id: 'requested' } });
    return { values: { messages }, config: { configurable: { checkpoint_id: 'actual' } } };
  } } } };
  assert.deepEqual(await getThreadMessages(agent, 'thread', 'requested'), {
    checkpointId: 'actual', messages: [
      { id: 'user-id', role: 'user', text: 'hello' },
      { id: 'message-2', role: 'assistant', text: '', toolCalls: [
        { id: 'a', name: 'action', args: { command: 'a' }, result: { output: 'first', truncated: false } },
        { id: 'b', name: 'action', args: { command: 'b' }, result: { output: 'second', truncated: false } },
        { id: 'pending', name: 'action', args: { command: 'pending' } },
      ] },
      { id: 'answer-id', role: 'assistant', text: 'done' },
    ],
  });
});

test('empty state returns empty history and omits checkpoint selection by default', async () => {
  const agent = { app: { graph: { async getState(config) {
    assert.deepEqual(config, { configurable: { thread_id: 'empty' } });
    return { values: {}, config: {} };
  } } } };
  const history = await getThreadMessages(agent, 'empty');
  assert.deepEqual(history.messages, []);
  assert.equal(history.checkpointId, undefined);
});

test('tool previews serialize blocks and bound output at exactly 10,000 characters', () => {
  for (const content of ['', 'a'.repeat(10_000), 'b'.repeat(10_001), [{ type: 'text', text: 'hello' }], [{ type: 'text', text: 'c'.repeat(10_000) }]]) {
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    assert.deepEqual(previewToolOutput(content), { output: serialized.slice(0, 10_000), truncated: serialized.length > 10_000 });
  }
});

for (const approved of [true, false]) {
  test(`real approval history attaches results after ${approved ? 'approval' : 'denial'} and supports checkpoint reads`, async () => {
    const { agent } = createApprovalAgent();
    await startTurn(agent, 'run test', 'approval', opts());
    const paused = await getThreadMessages(agent, 'approval');
    assert.ok(paused.checkpointId);
    const pendingCall = paused.messages.at(-1).toolCalls[0];
    assert.equal(paused.messages.at(-1).text, '');
    assert.equal(pendingCall.result, undefined);
    const pending = await getPendingApprovals(agent, 'approval');
    await resumeTurn(agent, { [pending[0].id]: approved }, 'approval', opts());
    const completed = await getThreadMessages(agent, 'approval');
    assert.deepEqual(completed.messages.find(m => m.toolCalls)?.toolCalls[0].result,
      { output: approved ? 'executed test-1' : 'declined', truncated: false });
    assert.deepEqual(await getThreadMessages(agent, 'approval', paused.checkpointId), paused);
  });
}

test('MemorySaver deletion removes history, checkpoints and pending approvals only for that thread', async () => {
  const { agent } = createApprovalAgent();
  await startTurn(agent, 'run test', 'deleted', opts());
  await startTurn(agent, 'hello', 'kept', opts());
  assert.ok((await getPendingApprovals(agent, 'deleted')).length);
  await deleteThreadState(agent, 'deleted');
  assert.deepEqual((await getThreadMessages(agent, 'deleted')).messages, []);
  assert.deepEqual(await getPendingApprovals(agent, 'deleted'), []);
  const checkpoints = [];
  for await (const checkpoint of agent.app.graph.checkpointer.list({ configurable: { thread_id: 'deleted' } })) checkpoints.push(checkpoint);
  assert.deepEqual(checkpoints, []);
  assert.equal((await getThreadMessages(agent, 'kept')).messages.length, 2);
});

test('deletion reports unsupported checkpointers meaningfully', async () => {
  for (const checkpointer of [undefined, false, true, {}]) {
    await assert.rejects(deleteThreadState({ app: { graph: { checkpointer } } }, 'thread'), /checkpointer.*delet/i);
  }
});

test('reused call ids across real turns retain each turn’s distinct result', async () => {
  const { agent } = createApprovalAgent();
  for (const approved of [true, false]) {
    await startTurn(agent, 'run test', 'reused', opts());
    const pending = await getPendingApprovals(agent, 'reused');
    await resumeTurn(agent, { [pending[0].id]: approved }, 'reused', opts());
  }
  const calls = (await getThreadMessages(agent, 'reused')).messages.flatMap(m => m.toolCalls ?? []);
  assert.deepEqual(calls.map(c => c.id), ['call-1', 'call-1']);
  assert.deepEqual(calls.map(c => c.result), [
    { output: 'executed test-1', truncated: false },
    { output: 'declined', truncated: false },
  ]);
});

test('duplicate unresolved ids consume results FIFO and ignore unmatched or extra results', async () => {
  const messages = [
    new ToolMessage({ content: 'orphan', tool_call_id: 'same' }),
    new AIMessage({ content: '', tool_calls: [call('same'), call('same'), call('pending')] }),
    new ToolMessage({ content: 'first', tool_call_id: 'same' }),
    new ToolMessage({ content: 'second', tool_call_id: 'same' }),
    new ToolMessage({ content: 'extra', tool_call_id: 'same' }),
    new AIMessage({ content: '', tool_calls: [call('same')] }),
  ];
  const agent = { app: { graph: { async getState() { return { values: { messages } }; } } } };
  const history = await getThreadMessages(agent, 'queue');
  assert.deepEqual(history.messages.flatMap(m => m.toolCalls).map(c => c.result), [
    { output: 'first', truncated: false },
    { output: 'second', truncated: false },
    undefined,
    undefined,
  ]);
});

test('missing snapshot values and config produce empty history', async () => {
  for (const state of [{}, { values: null, config: null }, { values: {}, config: {} }]) {
    const agent = { app: { graph: { async getState() { return state; } } } };
    assert.deepEqual(await getThreadMessages(agent, 'empty'), { checkpointId: undefined, messages: [] });
  }
});
