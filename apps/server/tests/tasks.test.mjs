import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import controllerModule from '../dist/tasks/tasks.controller.js';
import runtimeModule from '../dist/agent/agent.runtime.js';
import guardModule from '../dist/auth/token.guard.js';
import appModule from '../dist/app.module.js';
const { TasksController } = controllerModule;
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

async function server(t) {
  let enabled = true, busy = false; const removed = [];
  const runtime = {
    schedulerEnabled: async () => enabled,
    listTasks: async (limit, before) => ({ items: before ? [] : [{ id, prompt: 'Check build', threadId: 'thread', nextRunAt: '2026-01-01T00:00:00Z', repeatInterval: '1 hour', state: 'repeating' }], nextBefore: before ? null : id }),
    cancelTask: async task => { if (busy) { const error = new Error('Task is locked or running'); error.name = 'TaskBusyError'; throw error; } removed.push(task); return false; },
    taskRuns: async (limit, jobId, before) => ({ items: before ? [] : [{ id: '9', jobId: jobId ?? id, threadId: 'delivered-thread', status: 'success', output: 'done' }], nextBefore: before ? null : '9' }),
  };
  class TestModule {}
  assert.ok(Reflect.getMetadata('controllers', appModule.AppModule).includes(TasksController));
  Module({ controllers: [TasksController], providers: [{ provide: runtimeModule.AGENT_RUNTIME, useValue: runtime }] })(TestModule);
  const previous = process.env.WINGMAN_API_TOKEN; process.env.WINGMAN_API_TOKEN = 'tasks-test-only';
  const app = await NestFactory.create(TestModule, { logger: false }); app.useGlobalGuards(new guardModule.TokenGuard());
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.WINGMAN_API_TOKEN; else process.env.WINGMAN_API_TOKEN = previous; });
  const base = await app.getUrl();
  return { removed, enabled: value => { enabled = value; }, busy: value => { busy = value; },
    request: (path = '', method = 'GET', token = true) => fetch(`${base}/tasks${path}`, { method, headers: token ? { authorization: 'Bearer tasks-test-only' } : {}, signal: AbortSignal.timeout(4000) }) };
}

test('task APIs authenticate, validate and page schedules including disabled scheduling', async t => {
  const api = await server(t);
  assert.equal((await api.request('', 'GET', false)).status, 401);
  const first = await (await api.request('?limit=1')).json();
  assert.equal(first.schedulerEnabled, true); assert.equal(first.tasks[0].threadId, 'thread');
  assert.ok(first.nextCursor);
  const next = await (await api.request(`?cursor=${first.nextCursor}`)).json();
  assert.deepEqual(next.tasks, []); assert.equal(next.nextCursor, null);
  api.enabled(false);
  assert.equal((await (await api.request()).json()).schedulerEnabled, false);
  for (const query of ['?limit=101', '?limit=0', '?cursor=invalid']) assert.equal((await api.request(query)).status, 400);
});

test('cancellation is idempotent but locked jobs conflict without being removed', async t => {
  const api = await server(t);
  assert.equal((await api.request(`/${id}`, 'DELETE', false)).status, 401);
  assert.equal((await api.request('/bad', 'DELETE')).status, 400);
  assert.equal((await api.request(`/${id}`, 'DELETE')).status, 204);
  assert.equal((await api.request(`/${id}`, 'DELETE')).status, 204);
  api.busy(true);
  assert.equal((await api.request(`/${id}`, 'DELETE')).status, 409);
  assert.equal(api.removed.length, 2);
});

test('history pages retain task filter and remain readable independently of the schedule', async t => {
  const api = await server(t);
  const first = await (await api.request(`/runs?jobId=${id}&limit=1`)).json();
  assert.equal(first.runs[0].threadId, 'delivered-thread');
  const next = await (await api.request(`/runs?jobId=${id}&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(next.runs, []); assert.equal(next.nextCursor, null);
  assert.equal((await api.request(`/runs?jobId=${other}&cursor=${first.nextCursor}`)).status, 400);
  assert.equal((await api.request(`?cursor=${first.nextCursor}`)).status, 400);
  assert.equal((await api.request('/runs?jobId=bad')).status, 400);
  assert.equal((await api.request('/runs', 'GET', false)).status, 401);
});
