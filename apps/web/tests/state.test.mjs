import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:5173' });
for (const name of ['window', 'document', 'HTMLElement', 'localStorage']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { renderHook, act, waitFor, cleanup } = await import('@testing-library/react');
const { useWingman } = await import('../src/state/useWingman.ts');
const connection = { url: 'http://local.test', token: 'test-only' };

function apiFixture() {
  const controllers = new Map(); const pending = new Map(); const history = new Map();
  const calls = []; let postGate;
  globalThis.fetch = async (raw, options = {}) => {
    const url = new URL(raw); const parts = url.pathname.split('/'); const id = parts[2]; const endpoint = parts[3];
    calls.push({ endpoint, method: options.method, body: options.body });
    if (options.method === 'POST' && !id) return Response.json({ id: 'created' }, { status: 201 });
    if (options.method === 'POST') return postGate ? postGate() : Response.json({ runId: 'accepted' }, { status: 202 });
    if (endpoint === 'events') {
      const body = new ReadableStream({ start(controller) {
        controllers.set(id, controller);
        options.signal.addEventListener('abort', () => { controller.close(); }, { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (endpoint === 'pending') return Response.json(pending.get(id) ?? []);
    if (endpoint === 'messages') return Response.json(history.get(id) ?? { messages: [], nextCursor: null });
    return Response.json({ threads: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], nextCursor: null });
  };
  const sequences = new Map();
  return { pending, history, calls, setPost: fn => { postGate = fn; },
    emit(id, payload) {
      const sequence = (sequences.get(id) ?? 0) + 1; sequences.set(id, sequence);
      controllers.get(id).enqueue(new TextEncoder().encode(`id: ${id}:${sequence}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`));
    },
  };
}

test('a terminal SSE event arriving before POST returns never regresses to running', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  fixture.setPost(async () => {
    fixture.emit('one', { type: 'done', runId: 'accepted', text: 'finished' });
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ runId: 'accepted' }, { status: 202 });
  });
  await act(async () => { await hook.result.current.send('hello'); });
  assert.equal(hook.result.current.activity.phase, 'done');
  assert.equal(hook.result.current.working, false);
});

test('an approval arriving before resume acceptance remains visible', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  fixture.setPost(async () => {
    fixture.emit('one', { type: 'approval', runId: 'accepted', approvals: [{ id: 'second', command: 'test-2' }] });
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ runId: 'accepted' }, { status: 202 });
  });
  await act(async () => { await hook.result.current.resume({ first: true }); });
  assert.equal(hook.result.current.pending[0].id, 'second');
  assert.equal(hook.result.current.activity.phase, 'paused');
});

test('switching threads clears old state and historical terminal events clear stale approval cards', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  await act(async () => { fixture.emit('one', { type: 'approval', runId: 'run', approvals: [{ id: 'old', command: 'test' }] }); });
  assert.equal(hook.result.current.pending.length, 1);
  await act(async () => { hook.result.current.select('two'); });
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  assert.equal(hook.result.current.pending.length, 0);
  await act(async () => {
    fixture.emit('two', { type: 'approval', runId: 'old', approvals: [{ id: 'past', command: 'old' }] });
    fixture.emit('two', { type: 'done', runId: 'new', text: 'complete' });
  });
  assert.equal(hook.result.current.pending.length, 0);
  assert.equal(hook.result.current.activity.phase, 'done');
});

test('submitted prompts appear before acceptance and survive stale history without duplicating repeated text', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const previous = { id: 'previous', role: 'user', text: 'hello' };
  fixture.history.set('one', { messages: [previous], nextCursor: null });
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  let accept;
  fixture.setPost(() => new Promise(resolve => { accept = resolve; }));
  let sending;
  await act(async () => { sending = hook.result.current.send('hello'); });
  assert.deepEqual(hook.result.current.history.messages.map(message => message.text), ['hello', 'hello']);
  assert.match(hook.result.current.history.messages[1].id, /^local:/);
  await act(async () => { accept(Response.json({ runId: 'accepted' }, { status: 202 })); await sending; });
  await waitFor(() => assert.equal(hook.result.current.working, false));
  assert.equal(hook.result.current.history.messages.length, 2, 'stale history must retain the local prompt');
  fixture.history.set('one', { messages: [previous, { id: 'saved', role: 'user', text: 'hello' }], nextCursor: null });
  await act(async () => { fixture.emit('one', { type: 'done', runId: 'accepted', text: 'reply' }); });
  await waitFor(() => assert.deepEqual(hook.result.current.history.messages.map(message => message.id), ['previous', 'saved']));
});

test('a rejected submission removes the local prompt and reports failure', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  fixture.setPost(async () => Response.json({ message: 'Busy' }, { status: 409 }));
  let result;
  await act(async () => { result = await hook.result.current.send('hello'); });
  assert.equal(result, false);
  assert.equal(hook.result.current.history.messages.length, 0);
  assert.match(hook.result.current.error, /Busy/);
});

test('switching threads while a submission is pending discards its local prompt', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  let accept;
  fixture.setPost(() => new Promise(resolve => { accept = resolve; }));
  let sending;
  await act(async () => { sending = hook.result.current.send('hello'); });
  await act(async () => { hook.result.current.select('two'); });
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  await act(async () => { accept(Response.json({ runId: 'accepted' }, { status: 202 })); await sending; });
  assert.equal(hook.result.current.threadId, 'two');
  assert.equal(hook.result.current.history.messages.length, 0);
});


test('new conversation stays local until the first message is submitted', async t => {
  const original = globalThis.fetch; t.after(() => { cleanup(); globalThis.fetch = original; });
  localStorage.setItem('wingman.thread', 'one');
  const fixture = apiFixture();
  const hook = renderHook(() => useWingman(connection));
  await waitFor(() => assert.equal(hook.result.current.stream, 'live'));
  await act(async () => { hook.result.current.create(); });
  assert.equal(hook.result.current.threadId, null);
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 0);
  let accept;
  fixture.setPost(() => new Promise(resolve => { accept = resolve; }));
  let sending;
  await act(async () => { sending = hook.result.current.send('first message'); });
  assert.equal(hook.result.current.history.messages[0].text, 'first message');
  await act(async () => { accept(Response.json({ runId: 'accepted' }, { status: 202 })); await sending; });
  await waitFor(() => assert.equal(hook.result.current.threadId, 'created'));
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  assert.equal(hook.result.current.history.messages[0].text, 'first message');
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(hook.result.current.activity.phase, 'running');
});
