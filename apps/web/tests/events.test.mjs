import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventParser, watchEvents } from '../src/api/events.ts';
import { applyEvent, emptyActivity, toolsWithResults } from '../src/state/events.ts';

function response(text) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE parsing survives every chunk boundary, CRLF, comments and multiline data', () => {
  const text = ': heartbeat\r\nid: thread:9007199254740993\r\nevent: done\r\ndata: {"type":"done",\r\ndata: "text":"héllo"}\r\n\r\n';
  for (let cut = 0; cut <= text.length; cut++) {
    const frames = [];
    const parser = new EventParser(frame => frames.push(frame));
    parser.push(text.slice(0, cut)); parser.push(text.slice(cut));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].id, 'thread:9007199254740993');
    assert.deepEqual(JSON.parse(frames[0].data), { type: 'done', text: 'héllo' });
  }
});

test('reconnection sends the last processed ID, deduplicates replay and never posts', async () => {
  const controller = new AbortController(); const ids = []; const requests = [];
  await watchEvents({
    connection: { url: 'http://local.test', token: 'test-only' }, threadId: 'thread', signal: controller.signal,
    onStatus() {}, onError(error) { throw error; }, wait: async () => {},
    onEvent(event, id) { ids.push(id); if (event.type === 'done') controller.abort(); },
    fetcher: async (url, options) => {
      requests.push({ url, options });
      const route = 'id: thread:1\nevent: route\ndata: {"type":"route","runId":"run","choice":"fast","confidence":0}\n\n';
      return response(requests.length === 1 ? route : route + 'id: thread:2\nevent: done\ndata: {"type":"done","runId":"run","text":"done"}\n\n');
    },
  });
  assert.deepEqual(ids, ['thread:1', 'thread:2']);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['Last-Event-ID'], 'thread:1');
  assert.ok(requests.every(r => !r.options.method));
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.credentials, 'same-origin');
});

test('authentication and deleted-thread errors stop retrying', async () => {
  for (const status of [400, 401, 403, 404]) {
    let attempts = 0; let error;
    await watchEvents({ connection: { url: 'http://local.test', token: 'test-only' }, threadId: 'thread', signal: new AbortController().signal,
      onStatus() {}, onEvent() { assert.fail(); }, onError(e) { error = e; },
      fetcher: async () => { attempts++; return new Response('', { status }); },
      wait: async () => assert.fail('must not retry'),
    });
    assert.equal(attempts, 1); assert.equal(error.status, status);
  }
});

test('an already-aborted listener makes no requests', async () => {
  await watchEvents({ connection: { url: 'http://local.test', token: 'test' }, threadId: 'thread', signal: AbortSignal.abort(),
    onStatus() {}, onEvent() { assert.fail(); }, onError() { assert.fail(); }, fetcher: async () => assert.fail(),
  });
});

test('approval pauses a run and tool identifiers preserve results across resume runs', () => {
  let state = applyEvent(emptyActivity, { type: 'tool_call', runId: 'first', name: 'bash', toolCallId: 'call', args: { command: 'uptime' } });
  state = applyEvent(state, { type: 'approval', runId: 'first', approvals: [{ id: 'approval', command: 'uptime' }] });
  assert.equal(state.phase, 'paused');
  state = applyEvent(state, { type: 'tool_result', runId: 'resume', name: 'bash', toolCallId: 'call', output: 'up 1 day', truncated: false });
  assert.equal(state.phase, 'running');
  assert.deepEqual(toolsWithResults([{ id: 'call', name: 'bash', args: {} }], state.events)[0].result, { output: 'up 1 day', truncated: false });
  state = applyEvent(state, { type: 'done', runId: 'resume', text: 'up 1 day' });
  assert.equal(state.phase, 'done');
  assert.equal(state.runId, 'resume');
});

test('reused tool IDs never overwrite completed history or borrow an earlier result', () => {
  const completed = { id: 'reused', name: 'bash', args: {}, result: { output: 'old output', truncated: false } };
  const events = [
    { type: 'tool_result', runId: 'old', name: 'bash', toolCallId: 'reused', output: 'old output', truncated: false },
    { type: 'tool_call', runId: 'new', name: 'bash', toolCallId: 'reused', args: {} },
  ];
  assert.equal(toolsWithResults([{ id: 'reused', name: 'bash', args: {} }], events)[0].result, undefined);
  events.push({ type: 'tool_result', runId: 'new', name: 'bash', toolCallId: 'reused', output: 'new output', truncated: false });
  assert.deepEqual(toolsWithResults([completed], events)[0].result, completed.result);
});
