import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovalAgent } from '../../../tests/fixtures/approval-agent.mjs';
import { startTurn, resumeTurn, runUntilDone, getPendingApprovals, declinePending } from '../src/core/turn.ts';
const opts = () => ({ signal: new AbortController().signal });

test('a real graph pauses before a side effect and approval executes once', async () => {
  const { agent, executions } = createApprovalAgent();
  const paused = await startTurn(agent, 'run test', 'approve', opts());
  assert.equal(paused.kind, 'paused');
  assert.deepEqual(executions, []);
  const pending = await getPendingApprovals(agent, 'approve');
  assert.equal(pending[0].id, paused.interrupts[0].id);
  const result = await resumeTurn(agent, { [pending[0].id]: true }, 'approve', opts());
  assert.equal(result.kind, 'done');
  assert.match(result.text, /executed test-1/);
  assert.deepEqual(executions, ['test-1']);
  assert.deepEqual(await getPendingApprovals(agent, 'approve'), []);
});

test('declining never executes the side effect', async () => {
  const { agent, executions } = createApprovalAgent();
  const result = await runUntilDone(agent, 'run test', 'deny', async () => false, opts());
  assert.equal(result, 'declined');
  assert.deepEqual(executions, []);
});

test('parallel tool calls receive independent answers by interrupt id', async () => {
  const { agent, executions } = createApprovalAgent();
  assert.equal((await startTurn(agent, 'run two', 'parallel', opts())).kind, 'paused');
  const pending = await getPendingApprovals(agent, 'parallel');
  assert.equal(pending.length, 2);
  const result = await resumeTurn(agent, Object.fromEntries(pending.map(p => [p.id, p.command === 'test-2'])), 'parallel', opts());
  assert.equal(result.kind, 'done');
  assert.deepEqual(executions, ['test-2']);
});

test('threads retain independent pending state', async () => {
  const { agent } = createApprovalAgent();
  await startTurn(agent, 'run test', 'a', opts());
  await startTurn(agent, 'run test', 'b', opts());
  const a = await getPendingApprovals(agent, 'a');
  const b = await getPendingApprovals(agent, 'b');
  await resumeTurn(agent, { [a[0].id]: false }, 'a', opts());
  assert.deepEqual(await getPendingApprovals(agent, 'a'), []);
  assert.deepEqual(await getPendingApprovals(agent, 'b'), b);
});

test('cleanup permits a new message without executing an abandoned action', async () => {
  const { agent, executions } = createApprovalAgent();
  await startTurn(agent, 'run test', 'abandoned', opts());
  await declinePending(agent, 'abandoned', opts());
  assert.equal((await startTurn(agent, 'hello', 'abandoned', opts())).text, 'hello');
  assert.deepEqual(executions, []);
});

test('cleanup also declines a subsequent approval generated while cleaning up', async () => {
  const { agent, executions } = createApprovalAgent();
  await startTurn(agent, 'run twice', 'cleanup', opts());
  await declinePending(agent, 'cleanup', opts());
  assert.deepEqual(await getPendingApprovals(agent, 'cleanup'), []);
  assert.deepEqual(executions, []);
});

test('runUntilDone handles successive real graph pauses', async () => {
  const { agent, executions } = createApprovalAgent();
  const seen = [];
  await runUntilDone(agent, 'run twice', 'multiple', async r => { seen.push(r.command); return true; }, opts());
  assert.deepEqual(seen, ['test-1', 'test-2']);
  assert.deepEqual(executions, ['test-1', 'test-2']);
});
