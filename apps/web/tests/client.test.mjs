import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api/client.ts';

test('mutations use the same-origin proxy and JSON; resume answers keep every approval ID', async () => {
  const requests = [];
  const api = createApi({ url: 'http://local.test/api' }, async (url, options) => {
    requests.push({ url, ...options });
    return options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ runId: 'run' }, { status: 202 });
  });
  const signal = new AbortController().signal;
  await api.send('thread', 'hello', signal);
  await api.resume('thread', { one: true, two: false }, signal);
  await api.remove('thread', signal);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].credentials, 'same-origin');
  assert.equal(requests[0].url, 'http://local.test/api/threads/thread/messages');
  assert.deepEqual(JSON.parse(requests[0].body), { message: 'hello' });
  assert.deepEqual(JSON.parse(requests[1].body), { answers: { one: true, two: false } });
  assert.equal(requests[2].method, 'DELETE');
  assert.ok(requests.every(request => !request.url.includes('test-only')));
});

test('API errors expose status for recovery and commands are not retried', async () => {
  let calls = 0;
  const api = createApi({ url: 'http://local.test/api' }, async () => { calls++; return Response.json({ message: 'Busy' }, { status: 409 }); });
  await assert.rejects(api.send('thread', 'hello', new AbortController().signal), error => error.status === 409 && error.message === 'Busy');
  assert.equal(calls, 1);
});
