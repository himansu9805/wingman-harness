import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineJobs } from '../src/scheduler/jobs.ts';

test('Agenda awaits dispatch and persists deferral without rerunning the turn', async () => {
  let handler;
  defineJobs({ define(name, fn) { assert.equal(name, 'agent-task'); handler = fn; } }, async event => {
    assert.equal(event.threadId, 'thread');
    assert.equal(event.standalone, undefined);
    return { retryAt: new Date('2026-10-25') };
  });
  let saved = 0; let scheduled;
  await handler({ attrs: { _id: 'job', data: { prompt: 'reminder', threadId: 'thread' } }, schedule(date) { scheduled = date; }, async save() { saved++; } });
  assert.equal(scheduled.toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(saved, 1);
});

test('unbound jobs retain CLI thread IDs and are marked for standalone server delivery', async () => {
  let handler; let dispatched;
  defineJobs({ define(_name, fn) { handler = fn; } }, async event => { dispatched = event; });
  await handler({ attrs: { _id: 'job', data: { prompt: 'reminder' } } });
  assert.deepEqual(dispatched, { jobId: 'job', prompt: 'reminder', threadId: 'scheduled-job', standalone: true });
});
