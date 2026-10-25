import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskPage, cancelUnlockedTask, TaskBusyError } from '../src/scheduler/management.ts';

test('task listing bounds the page, normalizes dates and returns conversation and disabled state', async () => {
  let args;
  const row = { id: 'one', prompt: 'demo', thread_id: 'thread', next_run_at: new Date('2026-01-01'), repeat_interval: '1 hour', disabled: true };
  const db = { query: async (sql, values) => { args = { sql, values }; return { rows: [row, { ...row, id: 'two' }] }; } };
  const page = await taskPage(db, 1);
  assert.equal(page.items.length, 1); assert.equal(page.nextBefore, 'one');
  assert.equal(page.items[0].threadId, 'thread'); assert.equal(page.items[0].state, 'paused');
  assert.equal(page.items[0].nextRunAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(args.values, [null, 2]); assert.match(args.sql, /name='agent-task'/);
  row.locked_at = new Date();
  assert.equal((await taskPage(db, 1)).items[0].state, 'running', 'a lock takes priority over disabled state');
  await assert.rejects(taskPage(db, 101), /limit/);
});

test('cancellation is guarded by an atomic unlocked-row delete and reports busy separately from absent', async () => {
  const queries = [];
  const fake = results => ({ query: async (sql, params) => { queries.push({ sql, params }); return results.shift(); } });
  assert.equal(await cancelUnlockedTask(fake([{ rowCount: 1 }]), 'task'), true);
  assert.match(queries[0].sql, /locked_at IS NULL/);
  assert.match(queries[0].sql, /name='agent-task'/);
  await assert.rejects(cancelUnlockedTask(fake([{ rowCount: 0 }, { rowCount: 1 }]), 'task'), TaskBusyError);
  assert.equal(await cancelUnlockedTask(fake([{ rowCount: 0 }, { rowCount: 0 }]), 'task'), false);
});
