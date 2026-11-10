import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(filename)
        : /\.[jt]sx?$/.test(filename)
          ? [filename]
          : [];
    }),
  );
  return files.flat();
}

test("UI modules respect application, feature, and shared ownership", async () => {
  const violations = [];
  for (const filename of await sourceFiles(sourceRoot)) {
    const owner = path.relative(sourceRoot, filename).split(path.sep);
    const source = await readFile(filename, "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (!specifier.startsWith(".")) continue;
      const target = path
        .relative(sourceRoot, path.resolve(path.dirname(filename), specifier))
        .split(path.sep);
      let reason;
      if (owner[0] === "shared" && ["app", "features"].includes(target[0])) {
        reason = "shared code cannot depend on application or feature code";
      } else if (owner[0] === "features" && target[0] === "app") {
        reason = "features cannot depend on application composition";
      } else if (owner[0] === "features" && target[0] === "features" && owner[1] !== target[1]) {
        reason = "features communicate through application composition, not sibling internals";
      } else if (
        owner[0] === "features" &&
        ["model", "api"].includes(owner[2]) &&
        target[2] === "components"
      ) {
        reason = "feature models and APIs cannot depend on presentation";
      }
      if (reason)
        violations.push(`${path.relative(sourceRoot, filename)} → ${specifier}: ${reason}`);
    }
  }
  assert.deepEqual(violations, []);
});
