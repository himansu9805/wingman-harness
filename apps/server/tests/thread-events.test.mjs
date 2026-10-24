import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import threads from '../dist/threads/thread.repository.js';
import events from '../dist/threads/thread-events.repository.js';

test('event storage orders concurrent writes, isolates threads, copies data and rejects invalid cursors', async () => {
  const catalogue = new threads.MemoryThreadRepository();
  await catalogue.create('a'); await catalogue.create('b');
  const store = new events.MemoryThreadEventsRepository(catalogue);
  await store.init();
  const run = randomUUID();
  const payload = { type: 'done', text: 'hello' };
  await Promise.all(Array.from({ length: 20 }, () => store.append('a', run, payload)));
  payload.text = 'changed';
  const page = await store.listAfter('a', '0', 5);
  assert.deepEqual(page.map(e => e.sequence), ['1','2','3','4','5']);
  assert.equal(page[0].payload.text, 'hello');
  page[0].payload.text = 'mutated';
  assert.equal((await store.listAfter('a','0',1))[0].payload.text,'hello');
  assert.equal(await store.latest('a'), '20');
  assert.deepEqual(await store.listAfter('b','0',100), []);
  assert.equal((await store.listAfter('a','18',100)).length, 2);
  for (const cursor of ['-1','1.1','x','9223372036854775808']) await assert.rejects(store.listAfter('a',cursor,10));
  await assert.rejects(store.listAfter('a','0',0));
  await assert.rejects(store.append('missing',run,payload));
  await catalogue.markDeleting('a');
  await assert.rejects(store.append('a',run,payload));
  await store.close(); await store.close();
  await assert.rejects(store.listAfter('a','0',1));
});

test('run projection keeps only the latest snapshot per run before applying pagination', async () => {
  const catalogue = new threads.MemoryThreadRepository(); await catalogue.create('runs');
  const store = new events.MemoryThreadEventsRepository(catalogue);
  const first = randomUUID(), second = randomUUID();
  await store.append('runs', first, { type: 'run', metadata: { status: 'running' } });
  await store.append('runs', first, { type: 'run', metadata: { status: 'paused' } });
  await store.append('runs', second, { type: 'run', metadata: { status: 'running' } });
  await store.append('runs', second, { type: 'run', metadata: { status: 'completed' } });
  const page = await store.listRuns('runs', undefined, 1);
  assert.equal(page[0].runId, second);
  const rest = await store.listRuns('runs', page[0].sequence, 10);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].payload.metadata.status, 'paused');
  assert.deepEqual(await store.listRuns('runs', rest[0].sequence, 10), []);
  page[0].payload.metadata.status = 'changed';
  assert.equal((await store.listRuns('runs', undefined, 1))[0].payload.metadata.status, 'completed');
});
