import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { loadSkillContent } from "../skills/skills";
import { settings } from "../settings";
import { memoryTools } from "./memory";
import { schedulerTools } from "./scheduler";
import { bashTools } from "./bash";

/**
 * Loads the complete instructions for a named skill.
 */
const loadSkill = tool(
  async ({ name }) => {
    try {
      return await loadSkillContent(name);
    } catch (err) {
      return (err as Error).message;
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
        .describe(
          "A skill name copied exactly from the skills list, e.g. 'commit-message'.",
        ),
    }),
  },
);

export const tools = [
  loadSkill,
  ...memoryTools,
  ...bashTools,
  ...(settings.SCHEDULER_ENABLED ? schedulerTools : []),
];

export { MEMORY_TOOL_NAMES } from "./names";

export const SCHEDULER_TOOL_NAMES = new Set(schedulerTools.map((t) => t.name));
