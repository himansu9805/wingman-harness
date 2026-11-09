import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegationReporter } from "../src/delegation.ts";
const usage = {
  scope: "agent",
  modelCalls: 1,
  reportedCalls: 1,
  missingCalls: 0,
  availability: "complete",
  inputTokens: 5,
  outputTokens: 2,
  totalTokens: 7,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};
const snapshot = {
  type: "delegation_plan",
  planId: "plan-id-123",
  status: "running",
  elapsedMs: 10,
  error: null,
  tasks: [
    {
      key: "research",
      taskId: "worker-id",
      agentId: "analyst",
      status: "running",
      decisions: [],
      usage,
      processingMs: 10,
      error: null,
    },
  ],
};
test("CLI progress identifies task owners, deduplicates replay and treats child tokens as included totals", () => {
  const lines = [];
  const reporter = new DelegationReporter((line) => lines.push(line));
  reporter.update(snapshot);
  const count = lines.length;
  reporter.update(snapshot);
  assert.equal(lines.length, count);
  assert.equal(reporter.owner("worker-id", "orchestrator"), "research [analyst]");
  const done = {
    ...snapshot,
    status: "completed",
    tasks: [{ ...snapshot.tasks[0], status: "completed", processingMs: 1000 }],
  };
  reporter.update(done);
  assert.match(lines.join("\n"), /research \[analyst\]: Completed.*7 tokens/);
  assert.match(lines.join("\n"), /included in the turn total/);
  const completeCount = lines.length;
  reporter.update(done);
  assert.equal(lines.length, completeCount);
});

test("CLI invocation totals include coordinator and worker reports once across repeated snapshots", async () => {
  const { TurnAccounting } = await import("../src/delegation.ts");
  const accounting = new TurnAccounting();
  const opts = accounting.options(AbortSignal.timeout(1000), async () => {});
  const frame = (calls) => ({
    ...snapshot,
    tasks: [{ ...snapshot.tasks[0], usage: { ...usage, modelCalls: calls } }],
  });
  await opts.onEvent(frame(0));
  await opts.onModelUsage(
    {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
    "root",
  );
  await opts.onModelUsage(
    {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
    "worker",
    { taskId: "worker-id" },
  );
  await opts.onEvent(frame(1));
  await opts.onEvent(frame(1));
  assert.equal(accounting.totals().totalTokens, 14);
  assert.equal(accounting.totals().modelCalls, 2);
  await opts.onEvent(frame(2));
  assert.equal(accounting.totals().availability, "partial");
  assert.equal(accounting.totals().missingCalls, 1);
  assert.match(accounting.summary(), /At least 14 tokens.*3 model calls/);
  assert.equal(await accounting.decide(async () => false)({}), false);
});
