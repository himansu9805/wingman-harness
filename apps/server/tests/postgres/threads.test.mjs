import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createApprovalAgent } from '../../../../tests/fixtures/approval-agent.mjs';
import { startTurn, resumeTurn, getPendingApprovals, getThreadMessages, deleteThreadState } from '@wingman/core/turns';
import repositoryModule from '../../dist/threads/thread.repository.js';
const { PostgresThreadRepository } = repositoryModule;

const connectionString = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error('Set TEST_POSTGRES_CONNECTION_STRING for npm run test:postgres');
const options = () => ({ signal: AbortSignal.timeout(10_000) });

// Every run owns its own schema; no production checkpoint or catalogue is read.
test('Postgres preserves catalogue, history and pending approvals across reconnection, then deletes all state', { timeout: 30_000 }, async (t) => {
  const schema = `thread_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  const resources = [];
  t.after(async () => {
    try {
      for (const resource of resources.reverse()) await resource.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new URL(connectionString);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  const open = async () => {
    const repository = new PostgresThreadRepository(isolated.toString());
    const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    const saver = new PostgresSaver(pool, undefined, { schema });
    let closed = false;
    const resource = { async close() {
      if (closed) return;
      closed = true;
      try { await repository.close(); } finally { await pool.end(); }
    } };
    resources.push(resource);
    await repository.init();
    await saver.setup();
    return { repository, saver, ...createApprovalAgent({ checkpointer: saver }), close: resource.close };
  };

  const first = await open();
  const id = randomUUID();
  const keeper = randomUUID();
  await first.repository.create(id);
  await first.repository.create(keeper);
  await startTurn(first.agent, 'keeper conversation', keeper, options());
  await first.repository.touch(id, '  run a harmless action  ');
  await first.repository.touch(id, 'must not replace title');
  const paused = await startTurn(first.agent, 'run test', id, options());
  assert.equal(paused.kind, 'paused');
  const pending = await getPendingApprovals(first.agent, id);
  const before = await first.repository.get(id);
  assert.equal(before.title, 'run a harmless action');
  assert.equal(before.deleting, false);
  assert.deepEqual(first.executions, []);
  await first.close();

  const second = await open();
  assert.deepEqual(await second.repository.get(id), before);
  assert.deepEqual(await getPendingApprovals(second.agent, id), pending);
  assert.equal((await getThreadMessages(second.agent, id)).messages[0].text, 'run test');
  await resumeTurn(second.agent, { [pending[0].id]: true }, id, options());
  assert.deepEqual(second.executions, ['test-1']);
  const history = await getThreadMessages(second.agent, id);
  assert.equal(history.messages.flatMap(m => m.toolCalls ?? [])[0].result.output, 'executed test-1');

  // Force tied timestamps to exercise the SQL keyset independently of the clock.
  await admin.query(`UPDATE "${schema}".threads SET updated_at = $1`, ['2026-01-01T00:00:00.000Z']);
  const page = await second.repository.list({ limit: 1 });
  assert.equal(page.hasMore, true);
  const rest = await second.repository.list({ limit: 1, cursor: { updatedAt: page.items[0].updatedAt, id: page.items[0].id } });
  assert.equal(rest.hasMore, false);
  assert.equal(new Set([page.items[0].id, rest.items[0].id]).size, 2);
  const index = await admin.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='threads_updated_idx'`, [schema]);
  assert.equal(index.rowCount, 1);

  // A partial deletion survives reconnect and remains hidden until retry.
  await second.repository.markDeleting(id);
  await second.close();
  const third = await open();
  assert.equal((await third.repository.get(id)).deleting, true);
  assert.ok(!(await third.repository.list({ limit: 100 })).items.some(row => row.id === id));
  await deleteThreadState(third.agent, id);
  await third.repository.delete(id);
  await deleteThreadState(third.agent, id);
  assert.equal(await third.repository.get(id), null);
  assert.ok(await third.repository.get(keeper));
  assert.equal((await getThreadMessages(third.agent, keeper)).messages[0].text, 'keeper conversation');
  assert.deepEqual((await getThreadMessages(third.agent, id)).messages, []);
  for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
    const result = await admin.query(`SELECT count(*)::int n FROM "${schema}".${table} WHERE thread_id=$1`, [id]);
    assert.equal(result.rows[0].n, 0, `${table} was cleared`);
  }
});
