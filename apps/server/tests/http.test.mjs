import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AIMessage } from '@langchain/core/messages';
import appModule from '../dist/app.module.js';
const { AppModule } = appModule;
import AgentServiceModule from '../dist/agent/agent.service.js';
const { AgentService } = AgentServiceModule;
import AGENT_RUNTIMEModule from '../dist/agent/agent.runtime.js';
const { AGENT_RUNTIME } = AGENT_RUNTIMEModule;
import ThreadsControllerModule from '../dist/threads/threads.controller.js';
const { ThreadsController } = ThreadsControllerModule;
import TokenGuardModule from '../dist/auth/token.guard.js';
const { TokenGuard } = TokenGuardModule;
import repositoryModule from '../dist/threads/thread.repository.js';
const { THREAD_REPOSITORY, MemoryThreadRepository } = repositoryModule;
import { createApprovalAgent } from '../../../tests/fixtures/approval-agent.mjs';

import runnerModule from '../dist/agent/turn-runner.service.js';
import eventsModule from '../dist/threads/thread-events.repository.js';
const { TurnRunner } = runnerModule;
const { THREAD_EVENTS, MemoryThreadEventsRepository } = eventsModule;

const TOKEN = 'http-integration-test-only';
const TIMEOUT = 10_000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Gates have deadlines too: a failed assertion must never strand a server turn.
async function bounded(promise, signal = AbortSignal.timeout(4_000)) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function server(t, agent, options = {}) {
  const store = options.store ?? new MemoryThreadRepository();
  for (const id of ['auth', 'validation', 'fresh', 'approval', 'empty', 'parallel', 'twice', 'duplicate', 'busy', 'independent', 'failure', 'disconnect', 'abandoned', 'routing']) await store.create(id);
  const journal = new MemoryThreadEventsRepository(store);
  const previous = process.env.WINGMAN_API_TOKEN;
  process.env.WINGMAN_API_TOKEN = TOKEN;
  let app;
  let closed = 0;
  const requests = new Set();
  t.after(async () => {
    for (const controller of requests) controller.abort();
    try {
      if (app) await app.close();
    } finally {
      if (previous === undefined) delete process.env.WINGMAN_API_TOKEN;
      else process.env.WINGMAN_API_TOKEN = previous;
    }
    if (app) assert.equal(closed, 1, 'runtime closed exactly once');
  });
  // Exercise the shipped controller metadata and constructor injection. A local
  // root module replaces only the external agent runtime, never AgentService.
  assert.ok(Reflect.getMetadata('controllers', AppModule).includes(ThreadsController));
  class HttpTestModule {}
  Module({
    controllers: [ThreadsController],
    providers: [AgentService, TurnRunner, { provide: THREAD_EVENTS, useValue: journal }, { provide: THREAD_REPOSITORY, useValue: store }, {
      provide: AGENT_RUNTIME,
      useValue: { create: async () => agent, close: async () => { closed++; }, startScheduler: async () => {}, stopScheduler: async () => {}, recordRun: async () => {}, ...options.runtime },
    }],
  })(HttpTestModule);
  app = await NestFactory.create(HttpTestModule, { logger: false });
  app.useGlobalGuards(new TokenGuard());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  function request(path, { body, method, authorization = `Bearer ${TOKEN}`, signal, headers = {} } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    // Keep the deadline active through response body consumption, including SSE.
    return fetch(`${base}/threads/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json', connection: 'close', ...headers,
        ...(authorization === null ? {} : { authorization }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        controller.signal, t.signal, AbortSignal.timeout(4_000),
        ...(signal ? [signal] : []),
      ]),
    });
  }
  async function json(path, options, status = 200) {
    const response = await request(path, options);
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    return response.json();
  }
  async function stream(path, body) {
    const response = await request(path, { body });
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    const threadId = path.split('/')[0];
    const subscription = new AbortController();
    const listener = await request(`${threadId}/events`, { signal: subscription.signal });
    assert.equal(listener.status, 200);
    assert.match(listener.headers.get('content-type'), /^text\/event-stream/);
    const reader = listener.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    try {
      while (true) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'stream remains open across turns');
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (frame.startsWith(':')) continue;
          const parsed = events(frame)[0];
          if (parsed.data.runId !== runId) continue;
          assert.ok(Number.isFinite(Date.parse(parsed.data.createdAt)), 'SSE events expose durable timestamps');
          if (parsed.type === 'run') continue; // Existing behavior assertions exclude metadata snapshots.
          const { runId: ignored, createdAt: timestamp, type: payloadType, ...data } = parsed.data;
          frames.push({ type: parsed.type, data: ['done', 'approval', 'error'].includes(parsed.type) ? data : { type: payloadType, ...data } });
          if (['done', 'approval', 'error'].includes(parsed.type)) return frames;
        }
      }
    } finally { subscription.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return { request, json, stream, store, journal, service: app.get(AgentService), close: async () => { const closing = app; app = null; await closing.close(); assert.equal(closed, 1); } };
}

function events(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event: '));
    assert.ok(event, `missing SSE event in ${frame}`);
    return {
      type: event.slice(7),
      data: JSON.parse(lines.filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6)).join('\n')),
    };
  });
}

function terminal(frames, type) {
  assert.equal(frames.at(-1)?.type, type);
  assert.equal(frames.filter((frame) => ['done', 'approval', 'error'].includes(frame.type)).length, 1);
  return frames.at(-1).data;
}

function fakeAgent(run) {
  return { app: {
    graph: { getState: async () => ({ tasks: [] }) },
    stream: async (input, options) => run(input, options),
  } };
}

const doneUpdate = () => ({ model_request: { messages: [new AIMessage('hello')] } });
const progressUpdate = () => ({
  'TypeSafeModelRouterMiddleware.before_agent': {
    modelRoute: { choice: 'test', confidence: 1 },
  },
});

// Top-level node:test cases run serially: the token environment is process-wide.
test('HTTP authentication rejects absent, malformed, and incorrect tokens', { timeout: TIMEOUT }, async (t) => {
  const api = await server(t, fakeAgent(async function* () { yield doneUpdate(); }));
  for (const authorization of [null, 'Basic abc', 'Bearer wrong', 'Bearer ']) {
    await api.json('auth/pending', { authorization }, 401);
    await api.json('auth/messages', { authorization, body: { message: 'hello' } }, 401);
    await api.json('auth/resume', { authorization, body: { answers: {} } }, 401);
  }
  assert.deepEqual(await api.json('auth/pending'), []);
});

test('HTTP validates thread ids, messages, and resume bodies', { timeout: TIMEOUT }, async (t) => {
  const api = await server(t, fakeAgent(async function* () { yield doneUpdate(); }));
  for (const id of ['bad.id', 'a'.repeat(65)]) {
    await api.json(`${id}/pending`, undefined, 400);
    await api.json(`${id}/messages`, { body: { message: 'hello' } }, 400);
    await api.json(`${id}/resume`, { body: { answers: {} } }, 400);
  }
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 1 }, { message: 'a'.repeat(20_001) }]) {
    await api.json('validation/messages', { body }, 400);
  }
  for (const body of [{}, { answers: null }, { answers: [] }, { answers: { id: 'yes' } }]) {
    await api.json('validation/resume', { body }, 400);
  }
});

test('fresh pending is empty and a normal turn ends with SSE done', { timeout: TIMEOUT }, async (t) => {
  const fixture = await createApprovalAgent();
  const api = await server(t, fixture.agent);
  assert.deepEqual(await api.json('fresh/pending'), []);
  assert.deepEqual(terminal(await api.stream('fresh/messages', { message: 'hello' }), 'done'), { text: 'hello' });
  assert.deepEqual(await api.json('fresh/pending'), []);
  assert.equal(fixture.executions.length, 0);
});

for (const approved of [true, false]) {
  test(`approval round trip ${approved ? 'executes once' : 'denies without execution'}`, { timeout: TIMEOUT }, async (t) => {
    const fixture = await createApprovalAgent();
    const api = await server(t, fixture.agent);
    const { approvals } = terminal(await api.stream('approval/messages', { message: 'run test' }), 'approval');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].command, 'test-1');
    assert.equal(typeof approvals[0].id, 'string');
    assert.ok(approvals[0].id.length);
    assert.equal(fixture.executions.length, 0);
    assert.deepEqual(await api.json('approval/pending'), approvals);
    terminal(await api.stream('approval/resume', { answers: { [approvals[0].id]: approved } }), 'done');
    assert.equal(fixture.executions.length, approved ? 1 : 0);
    assert.deepEqual(await api.json('approval/pending'), []);
    await api.json('approval/resume', { body: { answers: { [approvals[0].id]: approved } } }, 409);
    assert.equal(fixture.executions.length, approved ? 1 : 0);
  });
}

test('resume requires exactly every pending id and rejects bad answers without consuming approvals', { timeout: TIMEOUT }, async (t) => {
  const fixture = await createApprovalAgent();
  const api = await server(t, fixture.agent);
  await api.json('empty/resume', { body: { answers: {} } }, 409);
  const { approvals } = terminal(await api.stream('parallel/messages', { message: 'run two' }), 'approval');
  assert.equal(approvals.length, 2);
  assert.equal(new Set(approvals.map(({ id }) => id)).size, 2);
  const valid = Object.fromEntries(approvals.map(({ id }) => [id, true]));
  for (const answers of [{}, { [approvals[0].id]: true }, { wrong: true },
    { ...valid, extra: true }, { ...valid, [approvals[0].id]: 'yes' }]) {
    await api.json('parallel/resume', { body: { answers } }, 400);
    assert.deepEqual(await api.json('parallel/pending'), approvals);
    assert.equal(fixture.executions.length, 0);
  }
  terminal(await api.stream('parallel/resume', { answers: valid }), 'done');
  assert.equal(fixture.executions.length, 2);
  assert.deepEqual(await api.json('parallel/pending'), []);
});

test('sequential approval stages expose only the current pending approval', { timeout: TIMEOUT }, async (t) => {
  const fixture = await createApprovalAgent();
  const api = await server(t, fixture.agent);
  const first = terminal(await api.stream('twice/messages', { message: 'run twice' }), 'approval').approvals;
  assert.equal(first.length, 1);
  const second = terminal(await api.stream('twice/resume', {
    answers: { [first[0].id]: true },
  }), 'approval').approvals;
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first[0].id);
  assert.deepEqual(await api.json('twice/pending'), second);
  assert.equal(fixture.executions.length, 1);
  await api.json('twice/resume', { body: { answers: { [first[0].id]: true } } }, 400);
  terminal(await api.stream('twice/resume', { answers: { [second[0].id]: true } }), 'done');
  assert.equal(fixture.executions.length, 2);
  assert.deepEqual(await api.json('twice/pending'), []);
});

test('simultaneous duplicate resume returns 409 and executes the command once', { timeout: TIMEOUT }, async (t) => {
  const fixture = await createApprovalAgent();
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const app = fixture.agent.app;
  const agent = { app: {
    graph: app.graph,
    stream: async (input, options) => {
      if (!Array.isArray(input.messages)) {
        entered.resolve();
        await bounded(release.promise, AbortSignal.any([options.signal, AbortSignal.timeout(4_000)]));
      }
      return app.stream(input, options);
    },
  } };
  const api = await server(t, agent);
  const { approvals } = terminal(await api.stream('duplicate/messages', { message: 'run test' }), 'approval');
  const answers = { [approvals[0].id]: true };
  const first = api.stream('duplicate/resume', { answers });
  first.catch(() => {});
  try {
    await bounded(entered.promise);
    await api.json('duplicate/resume', { body: { answers } }, 409);
    assert.equal(fixture.executions.length, 0);
  } finally {
    release.resolve();
    terminal(await first, 'done');
  }
  assert.equal(fixture.executions.length, 1);
  assert.deepEqual(await api.json('duplicate/pending'), []);
});

test('same-thread concurrent turns and resumes conflict while another thread can finish', { timeout: TIMEOUT }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const api = await server(t, fakeAgent(async function* (_input, options) {
    if (options.configurable.thread_id === 'busy') {
      entered.resolve();
      await bounded(release.promise, AbortSignal.any([options.signal, AbortSignal.timeout(4_000)]));
    }
    yield doneUpdate();
  }));
  const first = api.stream('busy/messages', { message: 'hello' });
  // Attach a handler immediately so an early failure cannot become unhandled.
  first.catch(() => {});
  try {
    await bounded(entered.promise);
    await api.json('busy/messages', { body: { message: 'hello' } }, 409);
    await api.json('busy/resume', { body: { answers: {} } }, 409);
    terminal(await api.stream('independent/messages', { message: 'hello' }), 'done');
  } finally {
    release.resolve();
    terminal(await first, 'done');
  }
  terminal(await api.stream('busy/messages', { message: 'hello' }), 'done');
});

for (const afterHeaders of [false, true]) {
  test(`background errors ${afterHeaders ? 'after progress' : 'before progress'} are persisted and release the lock`, { timeout: TIMEOUT }, async (t) => {
    let attempts = 0;
    const api = await server(t, fakeAgent(async function* () {
      if (attempts++ === 0) {
        if (afterHeaders) yield progressUpdate();
        throw new Error('deterministic turn failure');
      }
      yield doneUpdate();
    }));
    const frames = await api.stream('failure/messages', { message: 'hello' });
    if (afterHeaders) assert.equal(frames[0].type, 'route');
    assert.deepEqual(terminal(frames, 'error'), { message: 'Turn failed; check server logs' });
    assert.deepEqual(terminal(await api.stream('failure/messages', { message: 'hello' }), 'done'), { text: 'hello' });
  });
}

test('accepted turns finish after the requesting client disconnects', { timeout: TIMEOUT }, async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  let turnSignal;
  const api = await server(t, fakeAgent(async function* (_input, { signal }) {
    turnSignal = signal;
    yield progressUpdate();
    await bounded(release.promise);
    yield doneUpdate();
  }));
  const disconnect = new AbortController();
  const response = await api.request('disconnect/messages', { body: { message: 'hello' }, signal: disconnect.signal });
  assert.equal(response.status, 202);
  const { runId } = await response.json();
  disconnect.abort();
  release.resolve();
  await bounded((async () => {
    while (!(await api.journal.listAfter('disconnect', '0', 100)).some(row => row.runId === runId && row.payload.type === 'done')) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })());
  assert.equal(turnSignal.aborted, false);
});

test('a new message declines all abandoned approval stages before running', { timeout: TIMEOUT }, async (t) => {
  const fixture = createApprovalAgent();
  const api = await server(t, fixture.agent);
  terminal(await api.stream('abandoned/messages', { message: 'run twice' }), 'approval');
  assert.deepEqual(terminal(await api.stream('abandoned/messages', { message: '  hello  ' }), 'done'), { text: 'hello' });
  assert.deepEqual(await api.json('abandoned/pending'), []);
  assert.deepEqual(fixture.executions, []);
});

for (const confidence of [0, 0.0003665156881398346]) {
  test(`SSE preserves route probabilities and raw confidence ${confidence}`, { timeout: TIMEOUT }, async (t) => {
    const probabilities = { fast: 0.5112700443976795, powerful: 0.4887299556023205 };
    const api = await server(t, fakeAgent(async function* () {
      yield { 'TypeSafeModelRouterMiddleware.before_agent': { modelRoute: { choice: 'fast', confidence, probabilities } } };
      yield doneUpdate();
    }));
    const frames = await api.stream('routing/messages', { message: 'maths' });
    assert.deepEqual(frames[0], { type: 'route', data: { type: 'route', choice: 'fast', confidence, probabilities } });
    terminal(frames, 'done');
  });
}

test('threads must be explicitly created; unknown ids never create catalogue rows', { timeout: TIMEOUT }, async (t) => {
  const api = await server(t, createApprovalAgent().agent);
  for (const path of ['never-created/messages', 'never-created/pending']) {
    await api.json(path, path.endsWith('messages') ? { body: { message: 'hello' } } : undefined, 404);
  }
  await api.json('never-created/resume', { body: { answers: {} } }, 404);
  assert.equal(await api.store.get('never-created'), null);
  const { id } = await api.json('', { body: {} }, 201);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await api.json(`${id}/messages`), { messages: [], nextCursor: null });
  assert.deepEqual(await api.json(`${id}/pending`), []);
  terminal(await api.stream(`${id}/messages`, { message: '  first message  ' }), 'done');
  terminal(await api.stream(`${id}/messages`, { message: 'second message' }), 'done');
  assert.equal((await api.store.get(id)).title, 'first message');
  assert.deepEqual((await api.json(`${id}/messages`)).messages.map(m => [m.role, m.text]), [
    ['user', 'first message'], ['assistant', 'first message'], ['user', 'second message'], ['assistant', 'second message'],
  ]);
});

test('catalogue lists bounded pages with stable timestamp/id ordering and hides deletion markers', { timeout: TIMEOUT }, async (t) => {
  const store = new MemoryThreadRepository(() => new Date('2026-01-01T00:00:00.000Z'));
  const api = await server(t, createApprovalAgent().agent, { store });
  const first = await api.json('?limit=2');
  assert.equal(first.threads.length, 2);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await api.json(`?limit=2&cursor=${first.nextCursor}`);
  assert.equal(second.threads.length, 2);
  assert.equal(new Set([...first.threads, ...second.threads].map(r => r.id)).size, 4);
  const ids = [...first.threads, ...second.threads].map(r => r.id);
  assert.deepEqual(ids, [...ids].sort().reverse());
  await store.markDeleting(first.threads[0].id);
  assert.ok(!(await api.json('?limit=100')).threads.some(r => r.id === first.threads[0].id));
  for (const query of ['?limit=0', '?limit=101', '?limit=no', '?cursor=not-json', '?cursor=%21', '?limit=2&limit=3']) {
    await api.json(query, undefined, 400);
  }
});

test('history attaches approved and declined tool output to the original call', { timeout: TIMEOUT }, async (t) => {
  const { agent, executions } = createApprovalAgent();
  const api = await server(t, agent);
  const { id } = await api.json('', { body: {} }, 201);
  const approval = terminal(await api.stream(`${id}/messages`, { message: 'run test' }), 'approval').approvals[0];
  const pendingHistory = await api.json(`${id}/messages`);
  const call = pendingHistory.messages.flatMap(m => m.toolCalls ?? [])[0];
  assert.equal(call.name, 'test_action');
  assert.equal(call.result, undefined);
  terminal(await api.stream(`${id}/resume`, { answers: { [approval.id]: true } }), 'done');
  const history = await api.json(`${id}/messages`);
  const resolved = history.messages.flatMap(m => m.toolCalls ?? [])[0];
  assert.equal(resolved.id, call.id);
  assert.deepEqual(resolved.result, { output: 'executed test-1', truncated: false });
  assert.ok(history.messages.every(m => ['user', 'assistant'].includes(m.role)));
  assert.deepEqual(executions, ['test-1']);
  const { id: denied } = await api.json('', { body: {} }, 201);
  const paused = terminal(await api.stream(`${denied}/messages`, { message: 'run test' }), 'approval');
  terminal(await api.stream(`${denied}/resume`, { answers: { [paused.approvals[0].id]: false } }), 'done');
  assert.equal((await api.json(`${denied}/messages`)).messages.flatMap(m => m.toolCalls ?? [])[0].result.output, 'declined');
  assert.deepEqual(executions, ['test-1']);
});

test('history pages remain chronological and pinned to their snapshot as new messages arrive', { timeout: TIMEOUT }, async (t) => {
  const api = await server(t, createApprovalAgent().agent);
  const { id } = await api.json('', { body: {} }, 201);
  for (const message of ['first', 'second', 'third']) terminal(await api.stream(`${id}/messages`, { message }), 'done');
  const latest = await api.json(`${id}/messages?limit=2`);
  assert.deepEqual(latest.messages.map(m => m.text), ['third', 'third']);
  assert.ok(latest.nextCursor);
  terminal(await api.stream(`${id}/messages`, { message: 'fourth' }), 'done');
  const earlier = await api.json(`${id}/messages?limit=2&cursor=${latest.nextCursor}`);
  assert.deepEqual(earlier.messages.map(m => m.text), ['second', 'second']);
  const oldest = await api.json(`${id}/messages?limit=2&cursor=${earlier.nextCursor}`);
  assert.deepEqual(oldest.messages.map(m => m.text), ['first', 'first']);
  assert.equal(oldest.nextCursor, null);
  const { id: other } = await api.json('', { body: {} }, 201);
  await api.json(`${other}/messages?cursor=${latest.nextCursor}`, undefined, 400);
  await api.json(`${id}/messages?cursor=invalid`, undefined, 400);
  await api.json(`${id}/messages?limit=101`, undefined, 400);
});

test('deleting a paused thread removes state without executing it, and deleted ids stay unknown', { timeout: TIMEOUT }, async (t) => {
  const { agent, executions } = createApprovalAgent();
  const api = await server(t, agent);
  const { id } = await api.json('', { body: {} }, 201);
  terminal(await api.stream(`${id}/messages`, { message: 'run test' }), 'approval');
  for (let attempt = 0; attempt < 2; attempt++) {
    const deleted = await api.request(id, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');
  }
  for (const path of [`${id}/messages`, `${id}/pending`]) await api.json(path, undefined, 404);
  await api.json(`${id}/messages`, { body: { message: 'hello' } }, 404);
  await api.json(`${id}/resume`, { body: { answers: {} } }, 404);
  assert.equal((await api.store.get(id)), null);
  assert.deepEqual(executions, []);
  const snapshot = await agent.app.graph.getState({ configurable: { thread_id: id } });
  assert.deepEqual(snapshot.tasks, []);
  assert.ok(!snapshot.values.messages?.length);
});

test('thread deletion conflicts with an active turn', { timeout: TIMEOUT }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const api = await server(t, fakeAgent(async function* (_input, options) {
    entered.resolve();
    await bounded(release.promise, options.signal);
    yield doneUpdate();
  }));
  const running = api.stream('busy/messages', { message: 'hello' });
  running.catch(() => {});
  try {
    await bounded(entered.promise);
    await api.json('busy', { method: 'DELETE' }, 409);
    assert.equal((await api.store.get('busy')).deleting, false);
  } finally {
    release.resolve();
    terminal(await running, 'done');
  }
});

test('failed deletion stays hidden and can be retried without allowing new writes', { timeout: TIMEOUT }, async (t) => {
  const fixture = createApprovalAgent();
  const saver = fixture.agent.app.graph.checkpointer;
  const original = saver.deleteThread.bind(saver);
  let fail = true;
  saver.deleteThread = async id => {
    if (fail) { fail = false; throw new Error('test delete failure'); }
    return original(id);
  };
  const api = await server(t, fixture.agent);
  const { id } = await api.json('', { body: {} }, 201);
  terminal(await api.stream(`${id}/messages`, { message: 'hello' }), 'done');
  await api.json(id, { method: 'DELETE' }, 500);
  assert.equal((await api.store.get(id)).deleting, true);
  assert.ok(!(await api.json('?limit=100')).threads.some(thread => thread.id === id));
  await api.json(`${id}/messages`, { body: { message: 'hello' } }, 409);
  await api.json(`${id}/pending`, undefined, 409);
  const retry = await api.request(id, { method: 'DELETE' });
  assert.equal(retry.status, 204);
  await retry.text();
  assert.equal(await api.store.get(id), null);
});

test('catalogue endpoints also require authentication', { timeout: TIMEOUT }, async (t) => {
  const api = await server(t, createApprovalAgent().agent);
  await api.json('', { authorization: null }, 401);
  await api.json('', { body: {}, authorization: null }, 401);
  await api.json('fresh', { method: 'DELETE', authorization: null }, 401);
  await api.json('fresh/messages', { authorization: null }, 401);
});

test('metadata deletion can be retried after checkpoint deletion already succeeded', { timeout: TIMEOUT }, async (t) => {
  const store = new MemoryThreadRepository();
  const originalDelete = store.delete.bind(store);
  let fail = true;
  store.delete = async id => {
    if (fail) { fail = false; throw new Error('metadata deletion failed'); }
    return originalDelete(id);
  };
  const { agent, executions } = createApprovalAgent();
  const api = await server(t, agent, { store });
  const { id } = await api.json('', { body: {} }, 201);
  terminal(await api.stream(`${id}/messages`, { message: 'run test' }), 'approval');
  await api.json(id, { method: 'DELETE' }, 500);
  assert.equal((await store.get(id)).deleting, true);
  assert.deepEqual((await agent.app.graph.getState({ configurable: { thread_id: id } })).tasks, []);
  await api.json(`${id}/resume`, { body: { answers: {} } }, 409);
  const retry = await api.request(id, { method: 'DELETE' });
  assert.equal(retry.status, 204);
  await retry.text();
  assert.equal(await store.get(id), null);
  assert.deepEqual(executions, []);
});

test('new messages and duplicate deletes cannot race a deleting checkpoint', { timeout: TIMEOUT }, async (t) => {
  const fixture = createApprovalAgent();
  const entered = deferred();
  const release = deferred();
  const saver = fixture.agent.app.graph.checkpointer;
  const original = saver.deleteThread.bind(saver);
  t.after(() => release.resolve());
  saver.deleteThread = async id => {
    entered.resolve();
    await bounded(release.promise);
    return original(id);
  };
  const api = await server(t, fixture.agent);
  const { id } = await api.json('', { body: {} }, 201);
  const deleting = api.request(id, { method: 'DELETE' });
  deleting.catch(() => {});
  try {
    await bounded(entered.promise);
    await api.json(`${id}/messages`, { body: { message: 'hello' } }, 409);
    await api.json(id, { method: 'DELETE' }, 409);
    assert.equal((await api.store.get(id)).deleting, true);
  } finally {
    release.resolve();
    const response = await deleting;
    assert.equal(response.status, 204);
    await response.text();
  }
  await api.json(`${id}/messages`, { body: { message: 'hello' } }, 404);
});

test('resuming a paused turn updates catalogue activity without replacing its title', { timeout: TIMEOUT }, async (t) => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new MemoryThreadRepository(() => new Date(clock++));
  const api = await server(t, createApprovalAgent().agent, { store });
  const { id } = await api.json('', { body: {} }, 201);
  const created = await store.get(id);
  const approval = terminal(await api.stream(`${id}/messages`, { message: 'run test' }), 'approval').approvals[0];
  const paused = await store.get(id);
  terminal(await api.stream(`${id}/resume`, { answers: { [approval.id]: false } }), 'done');
  const resumed = await store.get(id);
  assert.equal(resumed.title, 'run test');
  assert.equal(resumed.createdAt, created.createdAt);
  assert.ok(paused.updatedAt > created.updatedAt);
  assert.ok(resumed.updatedAt > paused.updatedAt);
});

test('SSE replays bounded pages, isolates thread cursors, and supports independent reconnects', { timeout: TIMEOUT }, async t => {
  const api = await server(t, fakeAgent(async function* () { yield doneUpdate(); }));
  const runId = '00000000-0000-4000-8000-000000000001';
  for (let i = 0; i < 205; i++) await api.journal.append('fresh', runId, { type: 'done', text: String(i) });
  for (const cursor of ['fresh:206', 'fresh:01', 'fresh:-1', 'fresh:9223372036854775808', 'approval:1', 'garbage']) {
    await api.json('fresh/events', { headers: { 'last-event-id': cursor } }, 400);
  }
  await api.json('missing/events', undefined, 404);
  await api.json('fresh/events', { authorization: null }, 401);
  async function readCount(cursor, count) {
    const response = await api.request('fresh/events', { headers: { 'last-event-id': `fresh:${cursor}` } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    try {
      while ((text.match(/event: done/g) ?? []).length < count) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      return [...text.matchAll(/^id: fresh:(\d+)$/gm)].map(m => Number(m[1]));
    } finally { await reader.cancel(); }
  }
  const [all, reconnect] = await Promise.all([readCount(0, 205), readCount(200, 5)]);
  assert.deepEqual(all, Array.from({ length: 205 }, (_, i) => i + 1));
  assert.deepEqual(reconnect, [201, 202, 203, 204, 205]);
});

test('disconnecting an event subscriber preserves execution and replay finds the result', { timeout: TIMEOUT }, async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let signal;
  const api = await server(t, fakeAgent(async function* (_input, options) {
    signal = options.signal;
    yield progressUpdate();
    await bounded(gate.promise);
    yield doneUpdate();
  }));
  const { runId } = await api.json('disconnect/messages', { body: { message: 'hello' } }, 202);
  const response = await api.request('disconnect/events');
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /event: route/);
  await reader.cancel();
  assert.equal(signal.aborted, false);
  gate.resolve();
  await bounded((async () => {
    while (!(await api.journal.listAfter('disconnect', '0', 100)).some(row => row.runId === runId && row.payload.type === 'done')) await new Promise(resolve => setTimeout(resolve, 10));
  })());
  const replay = await api.request('disconnect/events', { headers: { 'last-event-id': 'disconnect:1' } });
  const replayReader = replay.body.getReader();
  try { assert.match(new TextDecoder().decode((await replayReader.read()).value), /event: done/); }
  finally { await replayReader.cancel(); }
});

test('deleting a thread ends subscribers and removes its journal', { timeout: TIMEOUT }, async t => {
  const api = await server(t, createApprovalAgent().agent);
  await api.stream('fresh/messages', { message: 'hello' });
  const response = await api.request('fresh/events', { headers: { 'last-event-id': 'fresh:1' } });
  const reader = response.body.getReader();
  assert.equal((await api.request('fresh', { method: 'DELETE' })).status, 204);
  while (!(await reader.read()).done) { /* Drain already-buffered metadata before EOF. */ }
  assert.deepEqual(await api.journal.listAfter('fresh', '0', 100), []);
});

test('shutdown aborts background work and closes idle event subscriptions', { timeout: TIMEOUT }, async t => {
  const entered = deferred();
  let signal;
  let terminal; let interrupted;
  const api = await server(t, fakeAgent(async function* (_input, options) {
    signal = options.signal; entered.resolve();
    await bounded(new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
    signal.throwIfAborted();
  }));
  const append = api.journal.append.bind(api.journal);
  api.journal.append = async (...args) => { if (args[2].type === 'error') terminal = args[2]; if (args[2].type === 'run' && args[2].metadata.status === 'interrupted') interrupted = args[2].metadata; return append(...args); };
  await api.json('fresh/messages', { body: { message: 'hello' } }, 202);
  await bounded(entered.promise);
  const subscription = await api.request('independent/events');
  const reader = subscription.body.getReader();
  await api.close();
  assert.equal(signal.aborted, true);
  assert.deepEqual(terminal, { type: 'error', message: 'Server stopped the turn' });
  assert.ok(interrupted.finishedAt);
  assert.ok(interrupted.turn.completedAt);
  while (!(await reader.read()).done) { /* Drain already-buffered metadata before EOF. */ }
});

test('server scheduler delivers results and approvals on the originating thread', { timeout: TIMEOUT }, async t => {
  const fixture = createApprovalAgent();
  const runs = []; let dispatch; let stopped = false;
  const api = await server(t, fixture.agent, { runtime: {
    startScheduler: async callback => { dispatch = callback; },
    stopScheduler: async () => { stopped = true; },
    recordRun: async run => { runs.push(run); },
  } });
  await dispatch({ jobId: 'job', prompt: 'run test', threadId: 'fresh' });
  const rows = await api.journal.listAfter('fresh', '0', 100);
  assert.equal(rows[0].payload.type, 'scheduled');
  assert.equal(rows.at(-1).payload.type, 'approval');
  assert.equal(runs[0].status, 'paused');
  assert.equal(runs[0].threadId, 'fresh');
  assert.equal((await api.store.get('fresh')).source, 'chat');
  const scheduledMetadata = (await api.json('fresh/runs')).runs[0];
  assert.equal(scheduledMetadata.origin, 'scheduled');
  assert.equal(scheduledMetadata.status, 'paused');
  assert.deepEqual(fixture.executions, []);
  const pending = await api.json('fresh/pending');
  const retry = await dispatch({ jobId: 'job2', prompt: 'hello', threadId: 'fresh' });
  assert.ok(retry.retryAt > new Date());
  assert.deepEqual(await api.json('fresh/pending'), pending);
  terminal(await api.stream('fresh/resume', { answers: { [pending[0].id]: true } }), 'done');
  assert.deepEqual(fixture.executions, ['test-1']);
  await dispatch({ jobId: 'job3', prompt: 'hello', threadId: 'fresh' });
  assert.equal(runs.at(-1).status, 'success');
  assert.equal(runs.at(-1).threadId, 'fresh');
  await api.close(); assert.equal(stopped, true);
});

test('scheduled turns defer while busy, never recreate deleted bound threads, and catalogue standalone results', { timeout: TIMEOUT }, async t => {
  const release = deferred(); t.after(() => release.resolve());
  const entered = deferred(); const runs = [];
  const api = await server(t, fakeAgent(async function* () { entered.resolve(); await bounded(release.promise); yield doneUpdate(); }), { runtime: { recordRun: async run => runs.push(run) } });
  await api.json('busy/messages', { body: { message: 'hello' } }, 202);
  await bounded(entered.promise);
  assert.ok((await api.service.dispatchScheduled({ jobId: 'busy-job', prompt: 'hello', threadId: 'busy' })).retryAt);
  release.resolve();
  await assert.rejects(api.service.dispatchScheduled({ jobId: 'missing-job', prompt: 'hello', threadId: 'deleted' }), e => e.status === 404);
  assert.equal(await api.store.get('deleted'), null);
  assert.equal(runs.at(-1).status, 'failed');
  await api.service.dispatchScheduled({ jobId: 'legacy-job', prompt: 'hello', threadId: 'scheduled-legacy-job', standalone: true });
  const standalone = runs.at(-1);
  assert.equal(standalone.status, 'success');
  assert.equal((await api.store.get(standalone.threadId)).source, 'scheduled');
  assert.equal((await api.store.get(standalone.threadId)).scheduled.taskId, 'legacy-job');
  assert.equal((await api.journal.listAfter(standalone.threadId, '0', 100))[0].payload.type, 'scheduled');
});

test('run metadata aggregates real model calls across approval resumes and is replayable and paginated', { timeout: TIMEOUT }, async t => {
  const fixture = createApprovalAgent({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  const api = await server(t, fixture.agent);
  const approval = terminal(await api.stream('approval/messages', { message: 'run test' }), 'approval').approvals[0];
  const paused = (await api.json('approval/runs')).runs[0];
  assert.equal(paused.status, 'paused');
  assert.equal(paused.turn.completedAt, null);
  assert.equal(paused.usage.totalTokens, 12);
  assert.equal(paused.usage.availability, 'complete');
  assert.equal(paused.usage.scope, 'agent');
  terminal(await api.stream('approval/resume', { answers: { [approval.id]: true } }), 'done');
  const page = await api.json('approval/runs?limit=1');
  const done = page.runs[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.turnId, paused.turnId);
  assert.equal(done.parentRunId, paused.runId);
  assert.equal(done.usage.modelCalls, 1);
  assert.equal(done.turn.usage.modelCalls, 2);
  assert.equal(done.turn.usage.totalTokens, 24);
  assert.ok(Date.parse(done.turn.completedAt) >= Date.parse(done.startedAt));
  assert.ok(done.approvalWaitMs >= 0);
  assert.ok(done.turn.processingMs >= done.processingMs);
  assert.ok(page.nextCursor);
  const older = await api.json(`approval/runs?limit=1&cursor=${page.nextCursor}`);
  assert.equal(older.runs[0].runId, paused.runId);
  assert.equal(older.nextCursor, null);
  await api.json(`fresh/runs?cursor=${page.nextCursor}`, undefined, 400);
  await api.json('approval/runs?limit=101', undefined, 400);
  await api.json('missing/runs', undefined, 404);
  await api.json('approval/runs', { authorization: null }, 401);
  // Replay the actual SSE transport and compare its final snapshot to the read API.
  const response = await api.request('approval/events');
  const reader = response.body.getReader();
  let text = '';
  try {
    while (!text.includes('event: done\n')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    const replay = events(text).filter(event => event.type === 'run' && event.data.runId === done.runId);
    assert.deepEqual(replay.at(-1).data.metadata, done);
    assert.ok(replay.every(event => Number.isFinite(Date.parse(event.data.createdAt))));
  } finally { await reader.cancel(); }
});

test('run metadata exposes in-progress, missing usage and failed runs without false completion', { timeout: TIMEOUT }, async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const api = await server(t, fakeAgent(async function* () { await bounded(gate.promise); yield doneUpdate(); throw new Error('failure after generation'); }));
  const { runId } = await api.json('fresh/messages', { body: { message: 'hello' } }, 202);
  const active = (await api.json('fresh/runs')).runs[0];
  assert.equal(active.runId, runId);
  assert.equal(active.status, 'running');
  assert.equal(active.finishedAt, null);
  assert.equal(active.turn.completedAt, null);
  gate.resolve();
  await bounded((async () => {
    while (!(await api.journal.listRuns('fresh', undefined, 1)).some(row => row.payload.metadata.status === 'failed')) await new Promise(resolve => setTimeout(resolve, 5));
  })());
  const failed = (await api.json('fresh/runs')).runs[0];
  assert.equal(failed.status, 'failed');
  assert.ok(failed.finishedAt);
  assert.equal(failed.usage.availability, 'unavailable');
  assert.equal(failed.usage.totalTokens, null);
  assert.equal(failed.usage.missingCalls, 1);
});
