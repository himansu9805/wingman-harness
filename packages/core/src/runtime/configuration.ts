import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { modelRouter } from "../integrations/models/router";
import type { AgentDefinition } from "../agents/definition";
import type { SkillMeta } from "../skills/catalogue";
import type { ExecutionResources } from "../agents/module";

/** Shared models and routing policy; fixed-model agents omit the router. */
export interface AgentModels {
  readonly fast: BaseChatModel;
  readonly powerful: BaseChatModel;
  readonly routingMiddleware: typeof modelRouter;
}

/** Trusted application assembly, separate from user messages and task input. */
export interface AgentConfiguration {
  /** Maximum simultaneous delegated workers across this runtime. */
  readonly delegationConcurrency?: number;
  readonly definitions: readonly AgentDefinition[];
  readonly globalTools: readonly StructuredToolInterface[];
  readonly agentTools?: Readonly<Record<string, readonly StructuredToolInterface[]>>;
  readonly models: AgentModels;
  readonly executionResources?: readonly ExecutionResources[];
  readonly prepareAgent?: (id: string) => Promise<void>;
}

/**
 * Application composition: add trusted role definitions and private tools here.
 * Shared capabilities are catalogued once; each definition opts into its subset.
 *
 * @param skills Snapshot of installed skills acquired by the owning runtime.
 */
export async function loadAgentConfiguration(
  skills: readonly SkillMeta[],
): Promise<AgentConfiguration> {
  const { createLocalTools } = await import("../capabilities/catalogue");
  const { fastModel, strongModel, modelRouter } = await import("../integrations/models/router");
  const { builtinAgentModules } = await import("../agents/builtins/index");
  const { assembleAgentModules } = await import("../agents/module");
  const { settings } = await import("../settings");
  return {
    ...assembleAgentModules(builtinAgentModules(settings.SCHEDULER_ENABLED)),
    globalTools: createLocalTools(skills),
    models: {
      fast: fastModel,
      powerful: strongModel,
      routingMiddleware: modelRouter,
    },
  };
}
