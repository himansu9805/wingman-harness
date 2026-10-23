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
    providers: [AgentService, { provide: THREAD_REPOSITORY, useValue: store }, {
      provide: AGENT_RUNTIME,
      useValue: { create: async () => agent, close: async () => { closed++; } },
    }],
  })(HttpTestModule);
  app = await NestFactory.create(HttpTestModule, { logger: false });
  app.useGlobalGuards(new TokenGuard());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  function request(path, { body, method, authorization = `Bearer ${TOKEN}`, signal } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    // Keep the deadline active through response body consumption, including SSE.
    return fetch(`${base}/threads/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
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
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    return events(await response.text());
  }
  return { request, json, stream, store };
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
  test(`errors ${afterHeaders ? 'after headers become SSE errors' : 'before headers become HTTP 500'} and release the lock`, { timeout: TIMEOUT }, async (t) => {
    let attempts = 0;
    const api = await server(t, fakeAgent(async function* () {
      if (attempts++ === 0) {
        if (afterHeaders) yield progressUpdate();
        throw new Error('deterministic turn failure');
      }
      yield doneUpdate();
    }));
    if (afterHeaders) {
      const frames = await api.stream('failure/messages', { message: 'hello' });
      assert.equal(frames[0].type, 'route');
      assert.deepEqual(terminal(frames, 'error'), { message: 'deterministic turn failure' });
    } else {
      const body = await api.json('failure/messages', { body: { message: 'hello' } }, 500);
      assert.equal(body.statusCode, 500);
    }
    assert.deepEqual(terminal(await api.stream('failure/messages', { message: 'hello' }), 'done'), { text: 'hello' });
  });
}

test('disconnect aborts the turn signal and closes the running iterator', { timeout: TIMEOUT }, async (t) => {
  const aborted = deferred();
  const finished = deferred();
  const disconnect = new AbortController();
  const api = await server(t, fakeAgent(async function* (_input, { signal }) {
    try {
      yield progressUpdate();
      if (!signal.aborted) {
        await bounded(new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
      }
      aborted.resolve(signal.aborted);
      signal.throwIfAborted();
    } finally {
      finished.resolve();
    }
  }));
  const response = await api.request('disconnect/messages', {
    body: { message: 'hello' }, signal: disconnect.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    assert.match(new TextDecoder().decode(chunk.value), /event: route/);
    disconnect.abort();
    assert.equal(await bounded(aborted.promise), true);
    await bounded(finished.promise);
  } finally {
    disconnect.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
