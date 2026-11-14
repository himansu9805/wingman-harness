import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { loadSkillContent, type SkillMeta } from "../skills/catalogue";
import { settings } from "../settings";
import { memoryTools } from "./memory";
import { schedulerTools } from "./scheduler";
import { createCommandTool } from "./commands";
import type { CommandExecutor } from "./execution/command-executor";

/**
 * Creates an agent-bound loader that refuses names outside its skill selection.
 * Rejected names never reach the content reader or reveal other installed skills.
 */
export function createLoadSkillTool(
  skills: readonly SkillMeta[],
  loadContent: (skill: SkillMeta) => Promise<string> = loadSkillContent,
) {
  const allowed = new Map(skills.map((skill) => [skill.name, { ...skill }]));
  return tool(
    async ({ name }) => {
      const skill = allowed.get(name);
      if (!skill) {
        return `Skill "${name}" is not available. Allowed skills: ${[...allowed.keys()].join(", ") || "(none)"}`;
      }
      try {
        return await loadContent(skill);
      } catch {
        return `Could not load skill "${name}".`;
      }
    },
    {
      name: "load_skill",
      description:
        "Loads the written instructions for one skill from the skills list in " +
        "the system prompt, e.g. 'commit-message'. Call it before starting a " +
        "task that matches a skill, then follow the instructions it returns. " +
        "Skills are instructions, not abilities: don't call this to find out " +
        "what you can do, and don't call it for tasks no skill matches.",
      schema: z.object({
        name: z
          .string()
          .describe("A skill name copied exactly from the skills list, e.g. 'commit-message'."),
      }),
    },
  );
}

/** Builds the shared catalogue; graph construction binds load_skill to its own selection. */
export function createLocalTools(
  skills: readonly SkillMeta[],
  executor: CommandExecutor,
): StructuredToolInterface[] {
  return [
    createLoadSkillTool(skills),
    ...memoryTools,
    createCommandTool(executor),
    ...(settings.SCHEDULER_ENABLED ? schedulerTools : []),
  ];
}

export { MEMORY_TOOL_NAMES } from "./names";

export const SCHEDULER_TOOL_NAMES = new Set(schedulerTools.map((t) => t.name));
