import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import threads from "../../dist/threads/thread.repository.js";
import events from "../../dist/threads/thread-events.repository.js";
const connectionString = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error("Set TEST_POSTGRES_CONNECTION_STRING");
test(
  "Postgres events serialize concurrent writers, replay after reconnect, reject failed writes without gaps and cascade on deletion",
  { timeout: 30000 },
  async (t) => {
    const schema = `events_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString });
    const resources = [];
    t.after(async () => {
      for (const r of resources) await r.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const catalogue = new threads.PostgresThreadRepository(url.toString());
    resources.push(catalogue);
    await catalogue.init();
    const first = new events.PostgresThreadEventsRepository(url.toString());
    resources.push(first);
    await first.init();
    await first.init();
    const second = new events.PostgresThreadEventsRepository(url.toString());
    resources.push(second);
    await second.init();
    await catalogue.create("a");
    await catalogue.create("b");
    const run = randomUUID();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? first : second).append("a", run, { type: "done", text: String(i) }),
      ),
    );
    assert.deepEqual(
      (await first.listAfter("a", "0", 100)).map((e) => e.sequence),
      Array.from({ length: 30 }, (_, i) => String(i + 1)),
    );
    await assert.rejects(first.append("a", "invalid-uuid", { type: "done", text: "bad" }));
    assert.equal((await first.append("a", run, { type: "done", text: "last" })).sequence, "31");
    await first.close();
    assert.equal((await second.listAfter("a", "29", 100)).length, 2);
    assert.deepEqual(await second.listAfter("b", "0", 100), []);
    const later = randomUUID();
    await second.append("a", run, { type: "run", metadata: { status: "running" } });
    await second.append("a", run, { type: "run", metadata: { status: "paused" } });
    await second.append("a", later, { type: "run", metadata: { status: "running" } });
    await second.append("a", later, { type: "run", metadata: { status: "completed" } });
    const reopened = new events.PostgresThreadEventsRepository(url.toString());
    resources.push(reopened);
    await reopened.init();
    assert.deepEqual(await reopened.latestStatuses(["a", "b"]), new Map([["a", "completed"]]));
    assert.deepEqual(await reopened.latestStatuses([]), new Map());
    const latest = await reopened.listRuns("a", undefined, 1);
    assert.equal(latest[0].payload.metadata.status, "completed");
    const previous = await reopened.listRuns("a", latest[0].sequence, 10);
    assert.equal(previous.length, 1);
    assert.equal(previous[0].payload.metadata.status, "paused");
    assert.deepEqual(await reopened.listRuns("a", previous[0].sequence, 10), []);
    assert.deepEqual(await reopened.listRuns("b", undefined, 10), []);
    await catalogue.create("snapshot");
    const oldRun = randomUUID();
    const middleRun = randomUUID();
    const currentRun = randomUUID();
    const resumedRun = randomUUID();
    await reopened.append("snapshot", oldRun, { type: "done", text: "Same reply" });
    await reopened.append("snapshot", middleRun, { type: "done", text: "Same reply" });
    await reopened.append("snapshot", currentRun, {
      type: "run",
      metadata: { turnId: currentRun, status: "running" },
    });
    await reopened.append("snapshot", currentRun, {
      type: "delegation_plan",
      planId: "plan",
      parentExecutionId: currentRun,
      status: "running",
    });
    await reopened.append("snapshot", currentRun, {
      type: "delegation_plan",
      planId: "plan",
      parentExecutionId: currentRun,
      status: "completed",
    });
    await reopened.append("snapshot", currentRun, {
      type: "run",
      metadata: { turnId: currentRun, status: "paused" },
    });
    await reopened.append("snapshot", resumedRun, {
      type: "run",
      metadata: { turnId: currentRun, status: "completed" },
    });
    const through = await reopened.latest("snapshot");
    await reopened.append("snapshot", resumedRun, { type: "done", text: "After watermark" });
    const page = await reopened.snapshot("snapshot", through, {
      messageIds: [currentRun],
      callIds: [],
      replies: [],
      latest: true,
    });
    assert.deepEqual(
      page.map(({ sequence }) => sequence),
      ["5", "6", "7"],
    );
    assert.equal(page[0].payload.status, "completed");
    const olderPage = await reopened.snapshot("snapshot", through, {
      messageIds: [],
      callIds: [],
      replies: [{ reply: "Same reply", take: 1, skip: 1 }],
      latest: false,
    });
    assert.deepEqual(
      olderPage.map(({ runId }) => runId),
      [oldRun],
    );
    await catalogue.markDeleting("a");
    await assert.rejects(second.append("a", run, { type: "done", text: "bad" }));
    await catalogue.create("titled");
    const claims = await Promise.all([
      catalogue.startMessage("titled", "Inspect Docker"),
      catalogue.startMessage("titled", "Inspect Docker"),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    const beforeTitle = await catalogue.get("titled");
    // A failed event insert must roll back both the title and its sequence allocation.
    await admin.query(
      `ALTER TABLE "${schema}".thread_events ADD CONSTRAINT reject_title CHECK (payload->>'type' <> 'thread_title') NOT VALID`,
    );
    await assert.rejects(second.completeTitle("titled", claim, run, "Generated title"));
    assert.equal((await catalogue.get("titled")).title, "Inspect Docker");
    assert.equal(await second.latest("titled"), "0");
    await admin.query(`ALTER TABLE "${schema}".thread_events DROP CONSTRAINT reject_title`);
    const titleResults = await Promise.all([
      second.completeTitle("titled", claim, run, "Docker inspection"),
      reopened.completeTitle("titled", claim, run, "Duplicate title"),
    ]);
    assert.equal(titleResults.filter(Boolean).length, 1);
    assert.equal((await second.listAfter("titled", "0", 100)).length, 1);
    assert.equal((await catalogue.get("titled")).updatedAt, beforeTitle.updatedAt);
    const reconnected = new threads.PostgresThreadRepository(url.toString());
    resources.push(reconnected);
    await reconnected.init();
    assert.equal(await reconnected.startMessage("titled", "Follow-up"), null);
    assert.equal((await reconnected.get("titled")).title, (await catalogue.get("titled")).title);
    await catalogue.delete("titled");
    await catalogue.create("titled");
    await catalogue.startMessage("titled", "New conversation query");
    assert.equal(await second.completeTitle("titled", claim, run, "Stale title"), false);
    assert.equal((await catalogue.get("titled")).title, "New conversation query");

    await catalogue.delete("a");
    assert.deepEqual(await second.listAfter("a", "0", 100), []);
    assert.ok(await catalogue.get("b"));
  },
);
