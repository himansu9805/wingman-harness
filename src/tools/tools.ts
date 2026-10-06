import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { loadSkillContent } from "@/skills/skills";
import { settings } from "@/settings";
import { memoryTools } from "@/tools/memory";
import { schedulerTools } from "@/tools/scheduler";
import { bashTools } from "@/tools/bash";

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
      "Loads the full instructions for a named skill. Call this before " +
      "attempting a task that matches one of the available skills.",
    schema: z.object({
      name: z.string().describe("The exact skill name from the skill index"),
    }),
  },
);

export const tools = [
  loadSkill,
  ...memoryTools,
  ...bashTools,
  ...(settings.SCHEDULER_ENABLED ? schedulerTools : []),
];

export const MEMORY_TOOL_NAMES = new Set([
  "remember",
  "recall_memory",
  "log_conversation",
]);

export const SCHEDULER_TOOL_NAMES = new Set(schedulerTools.map((t) => t.name));
