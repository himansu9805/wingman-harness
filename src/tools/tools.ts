import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { loadSkillContent } from "@/skills/skills";

/**
 * Evaluates a mathematical expression and returns the result as text.
 */
const calculator = tool(
  async ({ expression }) => {
    // we are using eval() here because this is a simple example, but in
    // production you should use a proper math expression parser
    try {
      const result = eval(expression);
      return String(result);
    } catch (error) {
      return `error evaluating ${expression}: ${(error as Error).message}`;
    }
  },
  {
    name: "calculator",
    description:
      "A simple calculator that evaluates mathematical expressions, e.g. '12 * (3 + 4)'.",
    schema: z.object({
      expression: z
        .string()
        .describe("The mathematical expression to evaluate."),
    }),
  },
);

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

export const tools = [calculator, loadSkill];
