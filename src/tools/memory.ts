import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GraphMemory } from "@/memory/graph";

const graphMemory = GraphMemory.getInstance();

const remember = tool(
  async ({ subject, subject_type, relation, object, object_type, notes }) => {
    await graphMemory.upsertEntity(subject, subject_type, notes ?? "");
    await graphMemory.upsertEntity(object, object_type, "");
    await graphMemory.upsertRelation(subject, relation, object);
    return `Remembered: ${subject} ${relation} ${object}`;
  },
  {
    name: "remember",
    description:
      "Saves one fact to long-term memory, kept across conversations. " +
      "A fact is a link between two names: subject → relation → object. " +
      "Use when the user asks you to remember something, or states a lasting " +
      "preference or fact about themselves or their work. Don't use it for " +
      "passing details of the current task. Examples: " +
      "{subject: 'User', subject_type: 'person', relation: 'works_on', " +
      "object: 'Wingman Harness', object_type: 'project'}; " +
      "{subject: 'User', subject_type: 'person', relation: 'prefers', " +
      "object: 'TypeScript over Python', object_type: 'fact'}. " +
      "Reuse names exactly as they appear in the memory list when they exist.",
    schema: z.object({
      subject: z
        .string()
        .describe(
          "Who or what the fact is about, e.g. the user's name. Reuse an existing name from the memory list if there is one.",
        ),
      subject_type: z
        .enum(["person", "project", "topic", "fact"])
        .describe("What kind of thing the subject is."),
      relation: z
        .string()
        .describe(
          "A short snake_case verb linking subject to object, e.g. 'works_on', 'prefers', 'lives_in', 'uses'.",
        ),
      object: z
        .string()
        .describe(
          "The other side of the fact. For a standalone preference, a short phrase, e.g. 'dark mode'.",
        ),
      object_type: z
        .enum(["person", "project", "topic", "fact"])
        .describe(
          "What kind of thing the object is. Use 'fact' for a short phrase like a preference.",
        ),
      notes: z
        .string()
        .optional()
        .describe(
          "Optional extra detail about the subject, e.g. their role. Leave out if there is none.",
        ),
    }),
  },
);

const recallMemory = tool(
  async ({ name }) => {
    // Small models sometimes copy a label along with the name, e.g.
    // "User (person)"; retry without it before reporting a miss.
    const result =
      (await graphMemory.recall(name)) ??
      (await graphMemory.recall(name.replace(/\s*\([^)]*\)\s*$/, "").trim()));
    return (
      result ??
      `No memory found for "${name}". Names must match the memory list ` +
        `exactly. If nothing there fits, tell the user you don't have that ` +
        `information.`
    );
  },
  {
    name: "recall_memory",
    description:
      "Loads the stored facts about one name from long-term memory: its notes " +
      "and every link to other names. Call it before answering questions " +
      "about the user, their projects, or anything in the memory list, e.g. " +
      "'what do you know about me?'. Pass a name copied exactly from the " +
      "memory list in the system prompt. Call it once per name you need.",
    schema: z.object({
      name: z
        .string()
        .describe(
          "A name copied exactly from the memory list, e.g. 'Himansu'. Not 'me', 'you' or 'the user'.",
        ),
    }),
  },
);

const logConversation = tool(
  async ({ summary, entities }) => {
    await graphMemory.recordConversation(summary, entities);
    return `Logged conversation: ${summary}`;
  },
  {
    name: "log_conversation",
    description:
      "Saves a short summary of this conversation to long-term memory, linked " +
      "to the names it was about. Use it at the end of a conversation that " +
      "made a decision or produced something worth recalling later. Don't use " +
      "it for greetings, small talk, or one-off questions.",
    schema: z.object({
      summary: z
        .string()
        .describe(
          "One or two sentences on what was discussed or decided, e.g. 'Chose Drizzle as the ORM for Wingman Harness.'",
        ),
      entities: z
        .array(z.string())
        .describe(
          "Names this conversation was about, e.g. ['Himansu', 'Wingman Harness']. Reuse names from the memory list when they exist.",
        ),
    }),
  },
);

export const memoryTools = [remember, recallMemory, logConversation];
