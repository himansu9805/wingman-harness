import assert from 'node:assert/strict';
import { test } from 'node:test';
import repositoryModule from '../dist/threads/thread.repository.js';
const { MemoryThreadRepository, PostgresThreadRepository, THREAD_REPOSITORY } = repositoryModule;

function fixture() {
  let now = new Date('2026-01-01T00:00:00.123Z');
  return {
    repo: new MemoryThreadRepository(() => now),
    advance: () => { now = new Date(now.getTime() + 1); },
  };
}

test('create/get return independent records and duplicate creation preserves data', async () => {
  const { repo } = fixture();
  await repo.init();
  assert.equal(typeof THREAD_REPOSITORY, 'symbol');
  assert.equal(await repo.get('missing'), null);
  const created = await repo.create('a');
  assert.deepEqual(created, { id: 'a', title: 'New conversation',
    createdAt: '2026-01-01T00:00:00.123Z', updatedAt: '2026-01-01T00:00:00.123Z', deleting: false });
  created.title = 'mutated';
  const fetched = await repo.get('a');
  assert.equal(fetched.title, 'New conversation');
  fetched.deleting = true;
  await assert.rejects(repo.create('a'), /already exists/);
  assert.equal((await repo.get('a')).deleting, false);
});

test('touch assigns only the first provided title, trims and truncates Unicode codepoints', async () => {
  const { repo, advance } = fixture();
  await repo.create('a');
  advance();
  await repo.touch('a');
  assert.equal((await repo.get('a')).title, 'New conversation');
  assert.equal((await repo.get('a')).updatedAt, '2026-01-01T00:00:00.124Z');
  const title = '😀'.repeat(79) + 'Z';
  await repo.touch('a', `  ${title}extra  `);
  advance();
  await repo.touch('a', 'replacement');
  const row = await repo.get('a');
  assert.equal(row.title, title);
  assert.equal(row.createdAt, '2026-01-01T00:00:00.123Z');
  assert.equal(row.updatedAt, '2026-01-01T00:00:00.125Z');
  await repo.create('b');
  await repo.touch('b', ' New conversation ');
  await repo.touch('b', 'replacement');
  assert.equal((await repo.get('b')).title, 'New conversation');
  await repo.create('empty');
  await repo.touch('empty', '   ');
  await repo.touch('empty', 'replacement');
  assert.equal((await repo.get('empty')).title, '');
  await repo.touch('missing', 'no implicit creation');
  assert.equal(await repo.get('missing'), null);
});

test('list uses descending timestamp and id keysets with accurate hasMore and copied rows', async () => {
  const { repo, advance } = fixture();
  for (const id of ['a', 'c', 'b']) await repo.create(id);
  advance();
  await repo.create('newest');
  const first = await repo.list({ limit: 2 });
  assert.deepEqual(first.items.map((row) => row.id), ['newest', 'c']);
  assert.equal(first.hasMore, true);
  const cursor = { updatedAt: first.items[1].updatedAt, id: first.items[1].id };
  first.items[1].title = 'mutation';
  assert.equal((await repo.get('c')).title, 'New conversation');
  const second = await repo.list({ limit: 2, cursor });
  assert.deepEqual(second.items.map((row) => row.id), ['b', 'a']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(await repo.list({ limit: 2, cursor: second.items[1] }), { items: [], hasMore: false });
  advance();
  await repo.touch('a');
  assert.equal((await repo.list({ limit: 1 })).items[0].id, 'a');
  for (const limit of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(repo.list({ limit }), RangeError);
});

test('tombstones remain readable and hidden across retryable deletion', async () => {
  const { repo } = fixture();
  await repo.create('a');
  await repo.create('b');
  await repo.markDeleting('b');
  await repo.markDeleting('b');
  assert.equal((await repo.get('b')).deleting, true);
  await repo.touch('b', 'still deleting');
  assert.equal((await repo.get('b')).deleting, true);
  assert.deepEqual((await repo.list({ limit: 1 })).items.map((row) => row.id), ['a']);
  assert.equal((await repo.list({ limit: 1 })).hasMore, false);
  await repo.delete('b');
  await repo.delete('b');
  await repo.markDeleting('missing');
  assert.equal(await repo.get('b'), null);
  assert.equal((await repo.create('b')).deleting, false);
});

test('close is idempotent and prevents reuse; Postgres validates configuration without connecting', async () => {
  const { repo } = fixture();
  await Promise.all([repo.close(), repo.close()]);
  await assert.rejects(repo.init(), /closed/);
  await assert.rejects(repo.get('a'), /closed/);
  assert.throws(() => new PostgresThreadRepository('  '), /connection string/);
  const postgres = new PostgresThreadRepository('postgresql://unused:unused@localhost/unused');
  await Promise.all([postgres.close(), postgres.close()]);
  await assert.rejects(postgres.get('a'), /closed/);
});
