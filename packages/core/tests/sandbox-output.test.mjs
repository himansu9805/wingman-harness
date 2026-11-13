import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxOutput } from "../src/capabilities/execution/sandbox-output.ts";

test("sandbox output replays bounded per-conversation data and unsubscribes", () => {
  const output = new SandboxOutput();
  output.publish("one", "previous");
  const seen = [];
  const subscription = output.subscribe("one", (text) => seen.push(text));
  assert.equal(subscription.snapshot, "previous");
  output.publish("two", "private to two");
  output.publish("one", "live");
  subscription.unsubscribe();
  output.publish("one", "x".repeat(70_000));
  assert.deepEqual(seen, ["live"]);
  const replay = output.subscribe("one", () => {});
  assert.equal(replay.snapshot.length, 65_536);
  assert(!replay.snapshot.includes("private to two"));
  replay.unsubscribe();
  output.clear("one");
  assert.equal(output.subscribe("one", () => {}).snapshot, "");
});
