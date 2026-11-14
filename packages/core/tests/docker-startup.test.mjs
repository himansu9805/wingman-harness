import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDocker } from "../src/capabilities/execution/sandbox/sandbox-docker-resources.ts";
import { DockerCommandExecutor } from "../src/capabilities/execution/sandbox/docker-command-executor.ts";

async function fakePath(t, script) {
  const directory = await mkdtemp(join(tmpdir(), "wingman-docker-check-"));
  const previous = process.env.PATH;
  process.env.PATH = directory;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  if (script !== undefined) {
    const path = join(directory, "docker");
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
  }
}

test("startup check rejects a missing Docker CLI", async (t) => {
  await fakePath(t);
  await assert.rejects(checkDocker(), /Docker CLI.*not found/i);
});

test("startup check rejects an unreachable Docker daemon before touching storage", async (t) => {
  await fakePath(t, "exit 1");
  const executor = new DockerCommandExecutor("postgres://invalid.invalid/no-database", "/unused");
  t.after(() => executor.close());
  await assert.rejects(executor.init(), /Docker daemon.*unavailable/i);
});

test("startup check accepts a reachable Docker daemon", async (t) => {
  await fakePath(t, 'if [ "$1" = info ]; then printf "28.0.0\\n"; else exit 1; fi');
  await checkDocker();
});
