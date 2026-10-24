import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { apiGuard, backendConfig } from '../server/backend.ts';

function checkGuard(config, url, headers = {}) {
  let next = false; let status; let body;
  apiGuard(config)({ url, headers }, { writeHead(value) { status = value; }, end(value) { body = value; } }, () => { next = true; });
  return { next, status, body };
}

test('environment configuration stays server-side and rejects invalid destinations', () => {
  assert.deepEqual(backendConfig({ PORT: '3002', WINGMAN_API_TOKEN: ' test ' }), { url: 'http://127.0.0.1:3002', token: 'test' });
  for (const url of ['file:///tmp/a', 'https://user:secret@host', 'http://host?token=x', 'http://host/#x']) assert.throws(() => backendConfig({ WINGMAN_API_URL: url }));
  assert.equal(checkGuard(backendConfig({}), '/api/threads').status, 503);
  assert.equal(checkGuard(backendConfig({}), '/').next, true);
});

test('private proxy rejects foreign origins and unrelated backend paths', () => {
  const config = backendConfig({ WINGMAN_API_TOKEN: 'test' });
  assert.equal(checkGuard(config, '/api/threads', { host: '127.0.0.1:5173', origin: 'http://other.invalid' }).status, 403);
  assert.equal(checkGuard(config, '/api/threads', { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }).next, true);
  assert.equal(checkGuard(config, '/api/admin').status, 404);
  assert.equal(checkGuard(config, '/api/threadsevil').status, 404);
  assert.equal(checkGuard(config, '/api/threads/../admin').status, 404);
  assert.equal(checkGuard(config, '/api/threads/%2e%2e/admin').status, 404);
});

test('the shipped web proxy injects auth, preserves event cursors, and streams without buffering', { timeout: 20_000 }, async t => {
  const token = 'proxy-test-token-must-stay-on-server';
  const requests = [];
  let sendEvent;
  const upstream = createHttpServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, cursor: req.headers['last-event-id'] });
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      sendEvent = () => res.write('id: thread:2\nevent: done\ndata: {"type":"done","runId":"run","text":"done"}\n\n');
    } else res.end(JSON.stringify({ threads: [], nextCursor: null }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.WINGMAN_API_URL; const previousToken = process.env.WINGMAN_API_TOKEN;
  process.env.WINGMAN_API_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.WINGMAN_API_TOKEN = token;
  let server;
  t.after(async () => {
    if (server) await server.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    if (previousUrl === undefined) delete process.env.WINGMAN_API_URL; else process.env.WINGMAN_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WINGMAN_API_TOKEN; else process.env.WINGMAN_API_TOKEN = previousToken;
  });
  server = await createViteServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer.address(); const base = `http://127.0.0.1:${address.port}`;
  const list = await fetch(`${base}/api/threads`, { headers: { authorization: 'Bearer client-must-not-override' } });
  assert.equal(list.status, 200); assert.ok(!(await list.text()).includes(token));
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/threads/thread/events`, { headers: { 'Last-Event-ID': 'thread:1' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) });
  assert.equal(stream.status, 200, 'idle SSE headers arrive before the first event');
  sendEvent();
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: done/);
  controller.abort(); await reader.cancel().catch(() => {});
  assert.deepEqual(requests, [
    { url: '/threads', auth: `Bearer ${token}`, cursor: undefined },
    { url: '/threads/thread/events', auth: `Bearer ${token}`, cursor: 'thread:1' },
  ]);
  const rejected = await fetch(`${base}/api/threads`, { headers: { Origin: 'http://other.invalid' } });
  assert.equal(rejected.status, 403); assert.equal(requests.length, 2);
});
