import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const configuration = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** Exercise real Git/Husky/Oxfmt in disposable repositories, never the caller's index. */
async function fixture(t, { install = true, dependencies = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wingman-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, "global.gitconfig"),
    XDG_CONFIG_HOME: join(directory, "config"),
    HUSKY: "1",
    CI: "false",
    NODE_ENV: "development",
    GIT_AUTHOR_NAME: "Hook test fixture",
    GIT_AUTHOR_EMAIL: "hooks@example.invalid",
    GIT_COMMITTER_NAME: "Hook test fixture",
    GIT_COMMITTER_EMAIL: "hooks@example.invalid",
  };
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 30000,
      ...options,
    });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trimEnd();
  };
  const put = async (name, text) => {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await put(
    "package.json",
    JSON.stringify({
      name: "hook-fixture",
      private: true,
      type: "module",
      scripts: { "format:staged": configuration.scripts["format:staged"] },
      "lint-staged": configuration["lint-staged"],
    }),
  );
  await copyFile(join(root, ".gitignore"), join(directory, ".gitignore"));
  await copyFile(join(root, ".gitattributes"), join(directory, ".gitattributes"));
  await copyFile(join(root, ".oxfmtrc.json"), join(directory, ".oxfmtrc.json"));
  await mkdir(join(directory, ".husky"));
  for (const name of ["pre-commit", "install.mjs"])
    await copyFile(join(root, ".husky", name), join(directory, ".husky", name));
  if (dependencies)
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  git("init", "--quiet", "--initial-branch=main");
  await put(
    "baseline.ts",
    'export const first = "before";\n' +
      Array.from({ length: 10 }, (_, n) => `export const value${n} = ${n};\n`).join("") +
      'export const last = "before";\n',
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Fixture baseline");
  if (install) {
    const result = run(process.execPath, [".husky/install.mjs"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git("config", "--get", "core.hooksPath"), ".husky/_");
  }
  return { directory, env, run, git, put };
}

test("committing formats staged filenames with spaces and preserves partially staged edits", async (t) => {
  const f = await fixture(t);
  await f.put("file with spaces.ts", "export const answer={value:'yes'}\n");
  const baseline = await readFile(join(f.directory, "baseline.ts"), "utf8");
  const staged = baseline.replace('export const first = "before";', "export const first='after'");
  await f.put("baseline.ts", staged);
  f.git("add", "baseline.ts", "file with spaces.ts");
  await f.put(
    "baseline.ts",
    staged.replace('export const last = "before";', 'export const last = "local-only";'),
  );
  f.git("commit", "--quiet", "-m", "Fixture formatted change");
  const committed = f.git("show", "HEAD:baseline.ts");
  assert.match(committed, /export const first = "after";/);
  assert(!committed.includes("local-only"));
  assert.match(await readFile(join(f.directory, "baseline.ts"), "utf8"), /"local-only"/);
  assert.equal(
    f.git("show", "HEAD:file with spaces.ts"),
    'export const answer = { value: "yes" };',
  );
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.equal(f.git("stash", "list"), "");
});

test("formatting failure blocks the commit and restores staged and unstaged files", async (t) => {
  const f = await fixture(t);
  const before = f.git("rev-parse", "HEAD");
  const invalid = "export const = ;\n";
  await f.put("invalid.ts", invalid);
  f.git("add", "invalid.ts");
  await f.put("invalid.ts", invalid + "// Unstaged note\n");
  await f.put("baseline.ts", "// Unstaged work must survive\n");
  const result = f.run("git", ["commit", "--quiet", "-m", "Must not commit"]);
  assert.notEqual(result.status, 0);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(f.git("show", ":invalid.ts"), invalid.trimEnd());
  assert.equal(
    await readFile(join(f.directory, "invalid.ts"), "utf8"),
    invalid + "// Unstaged note\n",
  );
  assert.equal(
    await readFile(join(f.directory, "baseline.ts"), "utf8"),
    "// Unstaged work must survive\n",
  );
  assert.equal(f.git("stash", "list"), "");
});

test("unsupported and ignored generated files can be committed without formatter changes", async (t) => {
  const f = await fixture(t);
  const generated = "generated syntax which is not valid JavaScript\n";
  await f.put("apps/web/src/astryx-themes.js", generated);
  await f.put("notes.unknown", "unsupported content\n");
  f.git("add", "apps/web/src/astryx-themes.js", "notes.unknown");
  f.git("commit", "--quiet", "-m", "Fixture ignored files");
  assert.equal(f.git("show", "HEAD:apps/web/src/astryx-themes.js"), generated.trimEnd());
  assert.equal(f.git("show", "HEAD:notes.unknown"), "unsupported content");
  f.git("rm", "baseline.ts");
  f.git("commit", "--quiet", "-m", "Fixture deletion only");
});

for (const overrides of [{ CI: "true" }, { NODE_ENV: "production" }]) {
  test(`prepare skips hook installation without dev dependencies in ${Object.keys(overrides)[0]}`, async (t) => {
    const f = await fixture(t, { install: false, dependencies: false });
    const result = f.run(process.execPath, [".husky/install.mjs"], {
      env: { ...f.env, ...overrides },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.run("git", ["config", "--get", "core.hooksPath"]).status, 1);
  });
}
