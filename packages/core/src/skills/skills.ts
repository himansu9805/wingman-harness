import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { settings } from "../settings";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

let cachedIndex: Promise<SkillMeta[]> | null = null;

/**
 * Splits a SKILL.md file into its YAML frontmatter and body.
 *
 * Files without a complete frontmatter block are treated as body-only.
 *
 * @param raw The complete contents of a SKILL.md file.
 * @returns The parsed frontmatter data and the remaining Markdown body.
 */
function splitFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }
  const [, frontmatterBlock, content] = match;
  const data = (parseYaml(frontmatterBlock) as Record<string, unknown>) ?? {};
  return { data, content };
}

/**
 * Finds skill definition files in the immediate subdirectories of a directory.
 *
 * Missing or unreadable directories and files are skipped.
 *
 * @param dir The directory containing skill subdirectories.
 * @returns Absolute paths to the discovered SKILL.md files.
 */
async function findSkillFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // Stat every entry concurrently rather than one at a time — this is
  // the main payoff of going async: N directory checks in parallel
  // instead of N sequential blocking syscalls.
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = (await stat(fullPath)).isDirectory();
      } catch {
        return null;
      }
      if (!isDir) return null;

      const candidate = join(fullPath, "SKILL.md");
      try {
        if ((await stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        // no SKILL.md in this folder so skip it
      }
      return null;
    }),
  );

  return results.filter((path): path is string => path !== null);
}

/**
 * Lists all valid skills discovered in the skills directory.
 *
 * @returns The cached list of skill metadata.
 */
export function listSkills(): Promise<SkillMeta[]> {
  if (cachedIndex) return cachedIndex;

  cachedIndex = (async () => {
    const skillFiles = await findSkillFiles(settings.SKILLS_DIR);

    // Read and parse every skill file concurrently.
    const parsed = await Promise.all(
      skillFiles.map(async (filePath) => {
        const raw = await readFile(filePath, "utf-8");
        const { data } = splitFrontmatter(raw);
        const name = data.name as string | undefined;
        const description = data.description as string | undefined;
        if (!name || !description) {
          console.warn(
            `[skills] Skipping ${filePath}: frontmatter missing "name" or "description".`,
          );
          return null;
        }
        return { name, description, path: filePath };
      }),
    );

    return parsed.filter((skill): skill is SkillMeta => skill !== null);
  })();

  return cachedIndex;
}

/**
 * Loads the Markdown body for a skill by name.
 *
 * @param name The name of the skill to load.
 * @returns The skill's Markdown content without its YAML frontmatter.
 * @throws {Error} If no skill with the specified name is available.
 */
export async function loadSkillContent(name: string): Promise<string> {
  const skills = await listSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const available = skills.map((s) => s.name).join(", ") || "(none)";
    throw new Error(`No skill named "${name}". Available skills: ${available}`);
  }
  const raw = await readFile(skill.path, "utf-8");
  const { content } = splitFrontmatter(raw);
  return content.trim();
}

/**
 * Renders a concise index of the available skills for inclusion in a prompt.
 *
 * @returns A Markdown-formatted skill index, or an empty string when no skills
 * are available.
 */
export async function renderSkillIndex(): Promise<string> {
  const skills = await listSkills();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "# Skills",
    "Skills are written instructions for specific tasks. They are not tools.",
    "When the user's request matches a skill below, call load_skill with its",
    "exact name BEFORE starting, then follow the loaded instructions. For",
    "anything else, ignore this list.",
    "",
    ...lines,
  ].join("\n");
}
