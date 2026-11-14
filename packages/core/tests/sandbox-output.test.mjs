import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxOutput } from "../src/capabilities/execution/sandbox/sandbox-output.ts";

test("sandbox output replays bounded per-conversation data and unsubscribes", () => {
  const output = new SandboxOutput();
  output.publish("one", "previous");
  const seen = [];
  const subscription = output.subscribeEvents("one", null, (event) => seen.push(event.text));
  assert.equal(subscription.events.map((event) => event.text).join(""), "previous");
  output.publish("two", "private to two");
  output.publish("one", "live");
  subscription.unsubscribe();
  output.publish("one", "x".repeat(70_000));
  assert.deepEqual(seen, ["live"]);
  const replay = output.subscribeEvents("one", null, () => {});
  const snapshot = replay.events.map((event) => event.text).join("");
  assert.equal(snapshot.length, 65_536);
  assert(!snapshot.includes("private to two"));
  replay.unsubscribe();
  output.clear("one");
  assert.deepEqual(output.subscribeEvents("one", null, () => {}).events, []);
});

test("sandbox event replay reports sequence gaps and isolates conversations", () => {
  const output = new SandboxOutput();
  const first = output.subscribeEvents("one", null, () => {});
  output.publish("one", "a");
  output.publish("two", "private");
  output.publish("one", "b");
  first.unsubscribe();
  const replay = output.subscribeEvents("one", first.cursor, () => {});
  assert.equal(replay.gap, false);
  assert.deepEqual(
    replay.events.map((event) => event.text),
    ["a", "b"],
  );
  assert(replay.events[1].sequence > replay.events[0].sequence);
  replay.unsubscribe();
  output.publish("one", "x".repeat(70_000));
  const expired = output.subscribeEvents("one", first.cursor, () => {});
  assert.equal(expired.gap, true);
  assert(!expired.events.some((event) => event.text.includes("private")));
  expired.unsubscribe();
  output.clear("one");
  const reset = output.subscribeEvents("one", first.cursor, () => {});
  assert.equal(reset.gap, true);
  reset.unsubscribe();
});
