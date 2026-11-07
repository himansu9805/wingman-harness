import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { modelRouter } from "../router";
import type { AgentDefinition } from "./definition";
import type { SkillMeta } from "../../skills/skills";

/** Shared models and routing policy; fixed-model agents omit the router. */
export interface AgentModels {
  readonly fast: BaseChatModel;
  readonly powerful: BaseChatModel;
  readonly routingMiddleware: typeof modelRouter;
}

/** Trusted application assembly, separate from user messages and task input. */
export interface AgentConfiguration {
  readonly definitions: readonly AgentDefinition[];
  readonly globalTools: readonly StructuredToolInterface[];
  readonly agentTools?: Readonly<Record<string, readonly StructuredToolInterface[]>>;
  readonly models: AgentModels;
}

/**
 * Application composition: add trusted role definitions and private tools here.
 * Shared capabilities are catalogued once; each definition opts into its subset.
 *
 * @param skills Snapshot of installed skills acquired by the owning runtime.
 */
export async function loadAgentConfiguration(skills: readonly SkillMeta[]): Promise<AgentConfiguration> {
  const { createLocalTools } = await import("../../tools/tools");
  const { fastModel, strongModel, modelRouter } = await import("../router");
  const { createDefaultAgentDefinition, analystAgentDefinition } = await import("./defaults");
  const { settings } = await import("../../settings");
  return {
    definitions: [createDefaultAgentDefinition(settings.SCHEDULER_ENABLED), analystAgentDefinition],
    globalTools: createLocalTools(skills),
    models: { fast: fastModel, powerful: strongModel, routingMiddleware: modelRouter },
  };
}
