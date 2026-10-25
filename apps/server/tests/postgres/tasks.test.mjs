import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { Agenda } from 'agenda';
import { PostgresBackend } from '@agendajs/postgres-backend';

const connectionString = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error('Set TEST_POSTGRES_CONNECTION_STRING');

test('task management uses Agenda persistence, refuses locked deletion and preserves bounded run history', { timeout: 30000 }, async t => {
  const schema = `tasks_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: url.toString() });
  const agenda = new Agenda({ backend: new PostgresBackend({ pool: db }) });
  let core;
  t.after(async () => {
    if (core) { await core.closeScheduler(); await core.closeResults(); }
    await agenda.stop(); await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  });
  Object.assign(process.env, { WINGMAN_HOME: `/tmp/${schema}`, POSTGRES_CONNECTION_STRING: url.toString(),
    DECISIONS_MODEL_BASE_URL: 'http://127.0.0.1:1', DECISIONS_MODEL_NAME: 'test', DECISIONS_MODEL_API_KEY: 'test-only',
    STRONG_MODEL_NAME: 'test', STRONG_MODEL_API_KEY: 'test-only', FAST_MODEL_BASE_URL: 'http://127.0.0.1:1', FAST_MODEL_NAME: 'test', FAST_MODEL_API_KEY: 'test-only' });
  core = await import('@wingman/core/tasks');
  await agenda.ready;
  const first = await agenda.schedule(new Date(Date.now() + 3600000), 'agent-task', { prompt: 'first', threadId: 'origin' });
  const second = await agenda.schedule(new Date(Date.now() + 7200000), 'agent-task', { prompt: 'standalone' });
  const foreign = await agenda.schedule(new Date(Date.now() + 7200000), 'other-job', { prompt: 'must remain' });
  const page = await core.listTaskPage(1);
  assert.equal(page.items.length, 1); assert.ok(page.nextBefore);
  const rest = await core.listTaskPage(10, page.nextBefore);
  assert.equal(rest.items.length, 1); assert.equal(rest.nextBefore, null);
  const all = [...page.items, ...rest.items];
  assert.equal(all.find(item => item.prompt === 'first').threadId, 'origin');
  assert.equal(all.find(item => item.prompt === 'standalone').threadId, null);
  const id = String(first.attrs._id);
  await db.query('UPDATE agenda_jobs SET locked_at=NOW() WHERE id=$1', [id]);
  await assert.rejects(core.cancelTask(id), /locked or running/);
  assert.equal((await db.query('SELECT id FROM agenda_jobs WHERE id=$1', [id])).rowCount, 1);
  await db.query('UPDATE agenda_jobs SET locked_at=NULL WHERE id=$1', [id]);
  await core.recordRun({ jobId: id, prompt: 'first', threadId: 'delivered', status: 'success', output: 'x'.repeat(17000), startedAt: new Date(), finishedAt: new Date() });
  await core.recordRun({ jobId: id, prompt: 'first', threadId: 'delivered', status: 'failed', error: 'test failure', startedAt: new Date(), finishedAt: new Date() });
  assert.equal(await core.cancelTask(id), true); assert.equal(await core.cancelTask(id), false);
  assert.equal(await core.cancelTask(String(foreign.attrs._id)), false);
  const runs = await core.getTaskRunPage(1, id); assert.equal(runs.items[0].status, 'failed');
  const older = await core.getTaskRunPage(1, id, runs.nextBefore);
  assert.equal(older.items[0].output.length, 16000); assert.equal(older.items[0].truncated, true);
  assert.equal(older.items[0].threadId, 'delivered'); assert.equal(older.nextBefore, null);
  await core.closeResults();
  assert.equal((await core.getTaskRunPage(10, id)).items.length, 2, 'history survives reconnection and cancellation');
  await core.closeScheduler();
  assert.equal((await core.listTaskPage(10)).items.length, 1, 'schedule remains available after reconnect');
});
