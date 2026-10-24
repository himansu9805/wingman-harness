import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import module from '../dist/threads/sse.js';
const { writeSse, eventFrame } = module;

test('SSE waits for drain and cleans up listeners after drain, close and abort', async () => {
  for (const finish of ['drain', 'close', 'abort']) {
    const response = new EventEmitter();
    response.write = () => false;
    const controller = new AbortController();
    const writing = writeSse(response, 'test', controller.signal);
    let finished = false;
    writing.then(() => { finished = true; }, () => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    if (finish === 'abort') controller.abort(); else response.emit(finish);
    if (finish === 'drain') await writing; else await assert.rejects(writing);
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('close'), 0);
    assert.equal(response.listenerCount('error'), 0);
  }
});

test('event frames carry durable IDs and correlate data with the accepted run', () => {
  const frame = eventFrame({ threadId: 'abc', sequence: '42', runId: 'run', payload: { type: 'done', text: 'line\nline' } });
  assert.equal(frame, 'id: abc:42\nevent: done\ndata: {"type":"done","text":"line\\nline","runId":"run"}\n\n');
});
