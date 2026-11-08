import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresDelegationStore } from '../../src/core/delegation/postgres-store.ts';
import { createDelegationRuntime } from '../../../../tests/fixtures/delegation-runtime.mjs';
import { startTurn, runTurn } from '../../src/core/turn.ts';
import { deleteThreadState } from '../../src/core/history.ts';

const connectionString = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error('Set TEST_POSTGRES_CONNECTION_STRING for Postgres delegation tests');

test('Postgres survives reconnection, atomically claims work, reuses results and deletes child state', { timeout: 30000 }, async t => {
  const schema = `delegation_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const resources = [];
  t.after(async () => {
    try {
      for (const close of resources.reverse()) await close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
  const open = async child => {
    const pool = new pg.Pool({ connectionString: url.toString() });
    const saver = new PostgresSaver(pool, undefined, { schema });
    await saver.setup();
    const store = new PostgresDelegationStore(url.toString());
    let closed = false;
    const f = await createDelegationRuntime({ store, saver, ...(child ? { child } : {}) });
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await f.runtime.close(); } finally { await pool.end(); }
    };
    resources.push(close);
    return { ...f, close };
  };
  const first = await open();
  await startTurn(first.agent, 'delegate', 'durable-chat', { signal: AbortSignal.timeout(10000) });
  const [original] = await first.store.listConversation('durable-chat');
  assert.equal(original.status, 'completed');
  assert.equal(original.usage[0].totalTokens, 7);
  await first.close();

  const second = await open(async () => { throw new Error('Completed child must not run again'); });
  assert.deepEqual((await second.store.listConversation('durable-chat'))[0], original);
  let pending;
  for await (const state of second.agent.app.graph.getStateHistory({ configurable: { thread_id: 'durable-chat' } })) {
    if (state.next.includes('tools')) { pending = state; break; }
  }
  assert.ok(pending);
  await second.agent.app.graph.updateState(pending.config, {}, 'model_request');
  const events = []; const usage = [];
  await runTurn(second.agent, null, 'durable-chat', { signal: AbortSignal.timeout(10000),
    onEvent: async event => events.push(event), onModelUsage: async counts => usage.push(counts) });
  assert.deepEqual(events.filter(event => event.type === 'delegation').map(event => event.phase), ['reused']);
  assert.equal(second.trace.calls.filter(call => call.child).length, 0);
  assert.equal(usage.length, 1);

  const competitor = new PostgresDelegationStore(url.toString());
  resources.push(() => competitor.close());
  await competitor.init();
  const request = original.request;
  const identity = { conversationId: 'atomic-chat', parentExecutionId: 'same-turn', parentToolCallId: 'same-call' };
  const input = { ...identity, request, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
  const claims = await Promise.all([second.store.claim(input), competitor.claim(input)]);
  assert.equal(claims.filter(claim => claim.created).length, 1);
  assert.equal(claims[0].task.taskId, claims[1].task.taskId);
  const blocked = await second.runtime.delegations.run('default', request, identity, { emit() {} });
  assert.equal(blocked.status, 'running');
  await assert.rejects(second.runtime.delegations.run('default', request, { ...identity, parentToolCallId: 'another-call' }, { emit() {} }), /Only one/);
  await assert.rejects(second.runtime.delegations.run('default', { ...request, context: 'changed' }, identity, { emit() {} }), /different task data/);
  await assert.rejects(second.store.recordUsage(original.taskId, original.usage[0]), /budget exhausted/);

  await deleteThreadState(second.agent, 'durable-chat');
  assert.deepEqual(await second.store.listConversation('durable-chat'), []);
  assert.equal(await second.saver.getTuple({ configurable: { thread_id: original.checkpointThreadId } }), undefined);
  assert.equal((await competitor.listConversation('atomic-chat')).length, 1);
});
