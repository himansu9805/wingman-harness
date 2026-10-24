import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
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
  assert.equal((await startTurn(agent, 'hello', 't', { ...options(), onEvent: async e => { events.push(e); } })).text, 'final');
  assert.deepEqual(events, [
    { type: 'route', choice: 'powerful', confidence: 0.8 },
    { type: 'tool_call', name: 'exec_bash_command', args: { command: 'pwd' }, toolCallId: '1' },
    { type: 'skill', name: 'haiku', toolCallId: '2' },
    { type: 'memory', name: 'recall_memory', args: { name: 'User' }, toolCallId: '3' },
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

for (const confidence of [0, 0.0003665156881398346, 0.8]) {
  test(`route events preserve probabilities and raw confidence ${confidence}`, async () => {
    const probabilities = { fast: 0.5112700443976795, powerful: 0.4887299556023205 };
    const agent = streamed([
      { 'TypeSafeModelRouterMiddleware.before_agent': { modelRoute: { choice: 'fast', confidence, probabilities } } },
      reply('answer'),
    ]);
    const events = [];
    await startTurn(agent, 'maths', 'route', { ...options(), onEvent: async e => { events.push(e); } });
    assert.deepEqual(events, [{ type: 'route', choice: 'fast', confidence, probabilities }]);
  });
}


test('tool updates emit each result with its call id before the final reply', async () => {
  const agent = streamed([
    { tools: { messages: [
      new ToolMessage({ name: 'exec_bash_command', tool_call_id: 'call-1', content: 'first output' }),
      new ToolMessage({ name: 'exec_bash_command', tool_call_id: 'call-2', content: 'second output' }),
    ] } },
    reply('finished'),
  ]);
  const events = [];
  const result = await startTurn(agent, 'x', 't', { ...options(), onEvent: async e => { events.push(e); } });
  assert.deepEqual(events, [
    { type: 'tool_result', name: 'exec_bash_command', toolCallId: 'call-1', output: 'first output', truncated: false },
    { type: 'tool_result', name: 'exec_bash_command', toolCallId: 'call-2', output: 'second output', truncated: false },
  ]);
  assert.deepEqual(result, { kind: 'done', text: 'finished' });
});

const asynchronousEventCases = [
  ['route', { 'TypeSafeModelRouterMiddleware.before_agent': { modelRoute: { choice: 'fast', confidence: 0.8 } } }],
  ...[
    ['tool_call', 'exec_bash_command', { command: 'pwd' }],
    ['skill', 'load_skill', { name: 'haiku' }],
    ['memory', 'recall_memory', { name: 'User' }],
  ].map(([type, name, args]) => [type, { model_request: { messages: [new AIMessage({ content: '', tool_calls: [{ name, args, id: type }] })] } }]),
  ['tool_result', { tools: { messages: [new ToolMessage({ content: 'output', name: 'exec_bash_command', tool_call_id: 'tool_call' })] } }],
];

test('all event writes finish in order before a turn completes, including calls and results in one batch', async () => {
  const calls = new AIMessage({ content: '', tool_calls: [
    { id: 'a', name: 'exec_bash_command', args: { command: 'pwd' } },
    { id: 'b', name: 'load_skill', args: { name: 'haiku' } },
    { id: 'c', name: 'recall_memory', args: { name: 'User' } },
  ] });
  const agent = streamed([
    asynchronousEventCases[0][1],
    { model_request: { messages: [calls] } },
    { tools: { messages: [
      new ToolMessage({ content: 'first', name: 'exec_bash_command', tool_call_id: 'a' }),
      new ToolMessage({ content: 'second', name: 'load_skill', tool_call_id: 'b' }),
    ] } },
    reply('finished'),
  ]);
  const writes = [];
  try {
    const result = await startTurn(agent, 'x', 'async-events', {
      ...options(),
      onEvent: async event => {
        const key = event.toolCallId ?? event.type;
        writes.push(`start:${key}`);
        await new Promise(resolve => setImmediate(resolve));
        writes.push(`saved:${key}`);
      },
    });
    writes.push('done');
    assert.deepEqual(writes, [
      'start:route', 'saved:route',
      'start:a', 'saved:a',
      'start:b', 'saved:b',
      'start:c', 'saved:c',
      'start:a', 'saved:a',
      'start:b', 'saved:b',
      'done',
    ]);
    assert.deepEqual(result, { kind: 'done', text: 'finished' });
  } finally {
    // Drain callbacks even when the regression assertion fails.
    await new Promise(resolve => setImmediate(resolve));
  }
});

for (const [type, update] of asynchronousEventCases) {
  test(`a rejected ${type} write rejects the turn and closes its iterator`, async () => {
    const failure = Promise.reject(new Error(`${type} persistence failed`));
    // Mark the promise handled even if a broken implementation ignores it.
    failure.catch(() => {});
    let closed = false;
    let advanced = false;
    const agent = streamed();
    agent.app.stream = async () => (async function* () {
      try {
        yield update;
        advanced = true;
        yield reply('must not finish');
      } finally { closed = true; }
    })();
    await assert.rejects(startTurn(agent, 'x', 'write-failure', {
      ...options(), onEvent: () => failure,
    }), new RegExp(`${type} persistence failed`));
    assert.equal(advanced, false);
    assert.equal(closed, true);
  });
}

test('server scheduling context reaches tools while CLI turns remain unbound', async () => {
  const agent = streamed([reply('ok')], [reply('ok')]);
  await startTurn(agent, 'schedule', 'server-thread', { ...options(), schedulerThreadId: 'server-thread' });
  assert.equal(agent.inputs[0].config.configurable.scheduler_thread_id, 'server-thread');
  await startTurn(agent, 'schedule', 'cli-thread', options());
  assert.equal(agent.inputs[1].config.configurable.scheduler_thread_id, undefined);
});

test('usage reports every model/tool-loop call once, keeps missing counts null, and awaits consumers', async () => {
  const call = new AIMessage({ id: 'model-1', content: '', tool_calls: [{ id: 'tool', name: 'test', args: {} }],
    usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
      input_token_details: { cache_read: 4 }, output_token_details: { reasoning: 1 } } });
  const update = { model_request: { messages: [call] } };
  const counts = [];
  await startTurn(streamed([update, update, reply('done')]), 'hello', 'usage', {
    ...options(), onModelUsage: async usage => { await Promise.resolve(); counts.push(usage); },
  });
  assert.deepEqual(counts, [
    { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, reasoningOutputTokens: 1 },
    { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
  ]);
});

test('failed model calls report unavailable usage before propagating the error', async () => {
  const counts = [];
  const agent = streamed();
  agent.app.stream = async (_input, config) => {
    await config.callbacks[0].handleLLMError(new Error('provider failed'));
    throw new Error('provider failed');
  };
  await assert.rejects(startTurn(agent, 'hello', 'failure', { ...options(), onModelUsage: async usage => { counts.push(usage); } }), /provider failed/);
  assert.equal(counts.length, 1);
  assert.equal(counts[0].totalTokens, null);
});
