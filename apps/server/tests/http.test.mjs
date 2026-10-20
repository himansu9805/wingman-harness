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

async function server(t, agent) {
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
    providers: [AgentService, {
      provide: AGENT_RUNTIME,
      useValue: { create: async () => agent, close: async () => { closed++; } },
    }],
  })(HttpTestModule);
  app = await NestFactory.create(HttpTestModule, { logger: false });
  app.useGlobalGuards(new TokenGuard());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  function request(path, { body, authorization = `Bearer ${TOKEN}`, signal } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    // Keep the deadline active through response body consumption, including SSE.
    return fetch(`${base}/threads/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
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
  return { request, json, stream };
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
