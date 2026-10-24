import assert from 'node:assert/strict';
import { test } from 'node:test';
import module from '../dist/agent/run-metadata.js';
const { emptyUsage, addUsage, startMetadata, finishMetadata } = module;
const counts = (input, output, total) => ({ inputTokens: input, outputTokens: output, totalTokens: total, cachedInputTokens: null, reasoningOutputTokens: null });

test('usage distinguishes zero, partial and unavailable without adding token subsets twice', () => {
  const zero = addUsage(emptyUsage(), counts(0, 0, 0));
  assert.equal(zero.availability, 'complete');
  assert.equal(zero.totalTokens, 0);
  const complete = addUsage(emptyUsage(), { ...counts(10, 4, 14), cachedInputTokens: 6, reasoningOutputTokens: 2 });
  const partial = addUsage(complete, counts(null, null, null));
  assert.equal(partial.availability, 'partial');
  assert.equal(partial.totalTokens, 14);
  assert.equal(partial.modelCalls, 2);
  assert.equal(partial.missingCalls, 1);
  assert.equal(addUsage(emptyUsage(), counts(null, null, null)).availability, 'unavailable');
  const combined = addUsage(complete, partial);
  assert.equal(combined.totalTokens, 28);
  assert.equal(combined.modelCalls, 3);
});

test('approval resumes share a turn while processing and approval waiting stay separate', () => {
  const start = startMetadata('first', 'message', new Date('2026-01-01T00:00:00Z'));
  const paused = finishMetadata(start, 'paused', new Date('2026-01-01T00:00:01Z'), 1000, addUsage(emptyUsage(), counts(10, 2, 12)));
  assert.equal(paused.turn.completedAt, null);
  const resumed = startMetadata('second', 'resume', new Date('2026-01-01T00:00:06Z'), paused);
  assert.equal(resumed.turnId, 'first');
  assert.equal(resumed.parentRunId, 'first');
  assert.equal(resumed.approvalWaitMs, 5000);
  const done = finishMetadata(resumed, 'completed', new Date('2026-01-01T00:00:08Z'), 2000, addUsage(emptyUsage(), counts(20, 3, 23)));
  assert.equal(done.turn.elapsedMs, 8000);
  assert.equal(done.turn.processingMs, 3000);
  assert.equal(done.turn.approvalWaitMs, 5000);
  assert.equal(done.turn.usage.totalTokens, 35);
  assert.equal(done.turn.completedAt, '2026-01-01T00:00:08.000Z');
  assert.equal(startMetadata('new', 'message', new Date(), paused).turnId, 'new');
  assert.equal(startMetadata('job', 'scheduled', new Date()).origin, 'scheduled');
  for (const status of ['failed', 'interrupted']) assert.ok(finishMetadata(resumed, status, new Date(), 1, emptyUsage()).turn.completedAt);
});
