import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadSkillContent, renderSkillIndex } from "../src/skills/skills.ts";
import { createLoadSkillTool } from "../src/tools/tools.ts";

test("scoped skill loader reads selected metadata and strips frontmatter", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wingman-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "SKILL.md");
  await writeFile(path, "---\nname: review\ndescription: Allowed skill\n---\nReview carefully.\n");
  const skill = { name: "review", description: "Allowed skill", path };
  assert.equal(await loadSkillContent(skill), "Review carefully.");
  const loader = createLoadSkillTool([skill]);
  assert.equal(await loader.invoke({ name: "review" }), "Review carefully.");
  assert.match(await loader.invoke({ name: "hidden" }), /not available. Allowed skills: review/);
  assert.match(renderSkillIndex([skill]), /review: Allowed skill/);
  assert.equal(renderSkillIndex([]), "");
});

test("loading tool modules does not initialize the graph database", () => {
  const memory = new URL("../src/memory/graph.ts", import.meta.url).href;
  const tools = new URL("../src/tools/tools.ts", import.meta.url).href;
  const source = `
    const { GraphMemory } = await import(${JSON.stringify(memory)});
    GraphMemory.getInstance = () => { throw new Error('Unexpected memory initialization'); };
    const { createLocalTools } = await import(${JSON.stringify(tools)});
    createLocalTools([]);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
});
