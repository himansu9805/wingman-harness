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
      "Saves a fact to long-term memory as a relationship between two " +
      "entities, persisting across conversations and restarts. Example: " +
      "subject='Himansu', relation='works_on', object='Wingman Harness'. " +
      "For a standalone preference or fact with no natural second " +
      "entity, use object_type 'fact' and a short phrase naming the " +
      "fact itself as the object. Use when the user explicitly asks you " +
      "to remember something, or states a standing preference or fact " +
      "clearly worth keeping for future sessions.",
    schema: z.object({
      subject: z.string().describe("The main entity this fact is about"),
      subject_type: z.enum(["person", "project", "topic", "fact"]),
      relation: z
        .string()
        .describe(
          "How subject relates to object, e.g. 'works_on', 'prefers', 'depends_on'",
        ),
      object: z.string().describe("The other entity in this relationship"),
      object_type: z.enum(["person", "project", "topic", "fact"]),
      notes: z
        .string()
        .optional()
        .describe("Optional extra detail about the subject entity"),
    }),
  },
);

const recallMemory = tool(
  async ({ name }) => {
    const result = await graphMemory.recall(name);
    return (
      result ??
      `No memory found for "${name}". Check the memory index for the exact entity name.`
    );
  },
  {
    name: "recall_memory",
    description:
      "Loads full details and connections for one specific entity from " +
      "long-term memory. Call this with an exact name from the memory " +
      "index before answering questions about that person, project, or topic.",
    schema: z.object({
      name: z.string().describe("The exact entity name from the memory index"),
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
      "Records a summary of this conversation in long-term memory, " +
      "linked to the people, projects, or topics it covered. Call this " +
      "near the end of a conversation that discussed something worth " +
      "remembering later.",
    schema: z.object({
      summary: z
        .string()
        .describe(
          "A one or two sentence summary of what this conversation covered",
        ),
      entities: z
        .array(z.string())
        .describe(
          "Names of people, projects, or topics this conversation was about",
        ),
    }),
  },
);

export const memoryTools = [remember, recallMemory, logConversation];
