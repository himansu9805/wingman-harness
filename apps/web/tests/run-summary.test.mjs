import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runSummary, usageDetails, duration } from '../src/state/run-summary.ts';
import { applyEvent, emptyActivity } from '../src/state/events.ts';
import { transcript } from '../src/state/transcript.ts';
import { RunSummary } from '../src/components/RunSummary.tsx';

const usage = { scope: 'agent', modelCalls: 2, reportedCalls: 2, missingCalls: 0, availability: 'complete',
  inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: null, reasoningOutputTokens: null };
function metadata(status = 'completed') {
  return { runId: 'resume', turnId: 'start', parentRunId: 'start', origin: 'resume', status,
    startedAt: '2026-01-01T00:00:05Z', finishedAt: status === 'running' ? null : '2026-01-01T00:00:06Z',
    elapsedMs: 1000, processingMs: 1000, approvalWaitMs: 4000, usage,
    turn: { startedAt: '2026-01-01T00:00:00Z', completedAt: ['running', 'paused'].includes(status) ? null : '2026-01-01T00:00:06Z',
      elapsedMs: 6000, processingMs: 2000, approvalWaitMs: 4000, usage } };
}

test('summary uses cumulative turn processing, approval waiting and counts with completion time', () => {
  const run = metadata();
  assert.match(runSummary(run)[0], /^Completed at /);
  assert.deepEqual(runSummary(run).slice(1), ['2 s processing', '4 s waiting for approval', '120 tokens']);
  assert.match(usageDetails(run), /routing classifier excluded/);
  assert.match(usageDetails(run), /2026-01-01T00:00:06Z/);
  assert.equal(duration(50), '50 ms');
  assert.equal(duration(65000), '1 min 5 s');
});

test('zero tokens stay zero, missing usage stays unavailable, partial totals are lower bounds', () => {
  const run = metadata();
  run.turn.usage = { ...usage, totalTokens: 0 };
  assert.ok(runSummary(run).includes('0 tokens'));
  run.turn.usage = { ...usage, totalTokens: null, availability: 'unavailable' };
  assert.ok(runSummary(run).includes('Token usage unavailable'));
  run.turn.usage = { ...usage, availability: 'partial' };
  assert.ok(runSummary(run).includes('At least 120 tokens'));
  run.turn.usage.totalTokens = null;
  assert.ok(runSummary(run).includes('Token usage incomplete'));
});

test('paused and failed runs do not claim successful completion, and running has no final footer', () => {
  assert.equal(runSummary(metadata('paused'))[0], 'Awaiting approval');
  assert.match(runSummary(metadata('failed'))[0], /^Failed at /);
  assert.match(runSummary(metadata('interrupted'))[0], /^Stopped at /);
  assert.equal(renderToStaticMarkup(createElement(RunSummary, { run: metadata('running') })), '');
  const html = renderToStaticMarkup(createElement(RunSummary, { run: metadata() }));
  assert.match(html, /2 s processing/);
  assert.match(html, /120 tokens/);
});

test('metadata snapshots replace rather than add counts and replay retains the terminal phase', () => {
  let state = emptyActivity;
  for (const status of ['running', 'paused', 'completed']) state = applyEvent(state, { type: 'run', runId: 'resume', metadata: metadata(status) });
  assert.equal(state.phase, 'done');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].metadata.turn.usage.totalTokens, 120);
  state = applyEvent(state, { type: 'run', runId: 'resume', metadata: metadata('failed') });
  assert.equal(state.phase, 'error');
});

test('explicit metadata turn IDs associate approval and resume snapshots with the matching answer', () => {
  const turns = transcript([
    { id: 'p1', role: 'user', text: 'first' }, { id: 'a1', role: 'assistant', text: 'finished' },
    { id: 'p2', role: 'user', text: 'second' }, { id: 'a2', role: 'assistant', text: 'other' },
  ], [
    { type: 'run', runId: 'start', metadata: { ...metadata('paused'), runId: 'start' } },
    { type: 'run', runId: 'resume', metadata: metadata() },
    { type: 'done', runId: 'resume', text: 'finished' },
    { type: 'done', runId: 'later', text: 'other' },
  ]);
  assert.deepEqual(turns[0].events.map(event => event.runId), ['start', 'resume', 'resume']);
  assert.deepEqual(turns[1].events.map(event => event.runId), ['later']);
});
