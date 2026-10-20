import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { runTurn, startTurn, resumeTurn, runUntilDone, getPendingApprovals, declinePending } from '../src/core/turn.ts';

const options = () => ({ signal: new AbortController().signal });
const approval = (id) => ({ id, value: { kind: 'bash_approval', command: id } });
function streamed(...batches) {
  const inputs = [];
  return { inputs, app: {
    async stream(input, config) {
      inputs.push({ input, config });
      const updates = batches.shift() ?? [];
      return (async function* () { yield* updates; })();
    },
    graph: { async getState() { return { tasks: [] }; } },
  } };
}
const reply = text => ({ model_request: { messages: [new AIMessage(text)] } });

test('startTurn passes a human message, thread and abort signal', async () => {
  const agent = streamed([reply('answer')]);
  const opts = options();
  assert.deepEqual(await startTurn(agent, 'hello', 'thread', opts), { kind: 'done', text: 'answer' });
  assert.ok(HumanMessage.isInstance(agent.inputs[0].input.messages[0]));
  assert.equal(agent.inputs[0].input.messages[0].text, 'hello');
  assert.equal(agent.inputs[0].config.configurable.thread_id, 'thread');
  assert.equal(agent.inputs[0].config.signal, opts.signal);
});

test('runTurn emits route, tool, skill and memory events and consumes the whole stream', async () => {
  const calls = [
    { id: '1', name: 'exec_bash_command', args: { command: 'pwd' } },
    { id: '2', name: 'load_skill', args: { name: 'haiku' } },
    { id: '3', name: 'recall_memory', args: { name: 'User' } },
  ];
  const agent = streamed([
    { 'TypeSafeModelRouterMiddleware.before_agent': { modelRoute: { choice: 'powerful', confidence: 0.8 } } },
    { tools: { messages: [] } },
    { model_request: { messages: [new HumanMessage('ignored')] } },
    { model_request: { messages: [new AIMessage({ content: '', tool_calls: calls })] } },
    reply('final'),
  ]);
  const events = [];
  assert.equal((await startTurn(agent, 'hello', 't', { ...options(), onEvent: e => events.push(e) })).text, 'final');
  assert.deepEqual(events, [
    { type: 'route', choice: 'powerful', confidence: 0.8 },
    { type: 'tool_call', name: 'exec_bash_command', args: { command: 'pwd' } },
    { type: 'skill', name: 'haiku' },
    { type: 'memory', name: 'recall_memory', args: { name: 'User' } },
  ]);
});

test('interrupts take precedence over a provisional final message', async () => {
  const pending = [approval('a'), approval('b')];
  const agent = streamed([reply('provisional'), { __interrupt__: pending }]);
  assert.deepEqual(await startTurn(agent, 'x', 't', options()), { kind: 'paused', interrupts: pending });
});

test('empty stream returns the documented fallback', async () => {
  assert.deepEqual(await startTurn(streamed([]), 'x', 't', options()), { kind: 'done', text: '(no response)' });
});

test('resumeTurn sends answers by interrupt id', async () => {
  const agent = streamed([reply('finished')]);
  await resumeTurn(agent, { a: true, b: false }, 't', options());
  assert.deepEqual(agent.inputs[0].input.resume, { a: true, b: false });
});

test('runUntilDone handles parallel approvals followed by another pause', async () => {
  const agent = streamed([{ __interrupt__: [approval('a'), approval('b')] }], [{ __interrupt__: [approval('c')] }], [reply('finished')]);
  const decisions = [];
  assert.equal(await runUntilDone(agent, 'x', 't', async r => { decisions.push(r.command); return r.command !== 'b'; }, options()), 'finished');
  assert.deepEqual(decisions, ['a', 'b', 'c']);
  assert.deepEqual(agent.inputs[1].input.resume, { a: true, b: false });
  assert.deepEqual(agent.inputs[2].input.resume, { c: true });
});

test('pending approvals are flattened across tasks', async () => {
  const agent = streamed();
  agent.app.graph.getState = async () => ({ tasks: [{ interrupts: [approval('a')] }, {}, { interrupts: [approval('b')] }] });
  assert.deepEqual(await getPendingApprovals(agent, 't'), [{ id: 'a', command: 'a' }, { id: 'b', command: 'b' }]);
});

test('declinePending leaves a clean thread alone', async () => {
  const agent = streamed();
  await declinePending(agent, 't', options());
  assert.equal(agent.inputs.length, 0);
});

test('declinePending answers false for all pending ids', async () => {
  const agent = streamed([reply('declined')]);
  agent.app.graph.getState = async () => ({ tasks: [{ interrupts: [approval('a'), approval('b')] }] });
  await declinePending(agent, 't', options());
  assert.deepEqual(agent.inputs[0].input.resume, { a: false, b: false });
});

test('stream failures propagate to the caller', async () => {
  const agent = streamed();
  agent.app.stream = async () => (async function* () { throw new Error('stream failed'); })();
  await assert.rejects(startTurn(agent, 'x', 't', options()), /stream failed/);
});

test('cancellation reaches the stream and propagates', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const agent = streamed();
  agent.app.stream = async (_input, config) => { config.signal.throwIfAborted(); };
  await assert.rejects(startTurn(agent, 'x', 't', { signal: controller.signal }), /cancelled/);
});

test('an approval callback failure stops runUntilDone without resuming', async () => {
  const agent = streamed([{ __interrupt__: [approval('a')] }]);
  await assert.rejects(runUntilDone(agent, 'x', 't', async () => { throw new Error('prompt closed'); }, options()), /prompt closed/);
  assert.equal(agent.inputs.length, 1);
});

test('cleanup stops with an explicit error if a model endlessly requests approvals', async () => {
  const agent = streamed();
  let rounds = 0;
  agent.app.graph.getState = async () => ({ tasks: [{ interrupts: [approval('a')] }] });
  agent.app.stream = async () => {
    rounds++;
    return (async function* () { yield { __interrupt__: [approval('a')] }; })();
  };
  await assert.rejects(declinePending(agent, 't', options()), /cleanup exceeded 25 rounds/);
  assert.equal(rounds, 25);
});

test('cleanup respects cancellation between successive pauses', async () => {
  const agent = streamed();
  const controller = new AbortController();
  agent.app.graph.getState = async () => ({ tasks: [{ interrupts: [approval('a')] }] });
  agent.app.stream = async () => (async function* () {
    controller.abort(new Error('cleanup cancelled'));
    yield { __interrupt__: [approval('b')] };
  })();
  await assert.rejects(declinePending(agent, 't', { signal: controller.signal }), /cleanup cancelled/);
});
