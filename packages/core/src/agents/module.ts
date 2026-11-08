import type { StructuredToolInterface } from "@langchain/core/tools";
import { AgentDefinitionSchema, type AgentDefinition } from "./definition";

/** Resources tied to checkpoint executions, owned and drained by the runtime. */
export interface ExecutionResources {
  release(threadId: string): Promise<void>;
  close(): Promise<void>;
}

/** One independently registerable role and its private capabilities. */
export interface AgentModule {
  definition: AgentDefinition;
  delegatedBy?: readonly string[];
  tools?: readonly StructuredToolInterface[];
  resources?: ExecutionResources;
  prepare?: () => Promise<void>;
}

export interface AgentModuleInput {
  id: string;
  description: string;
  instructions: string;
  model?: AgentDefinition["model"];
  execution?: AgentDefinition["execution"];
  delegation?: Partial<AgentDefinition["delegation"]>;
  capabilities?: Partial<AgentDefinition["capabilities"]>;
  delegatedBy?: readonly string[];
  tools?: readonly StructuredToolInterface[];
  resources?: ExecutionResources;
  prepare?: () => Promise<void>;
}

/** Define a role with no implicit capability grants; tools and MCP remain explicit opt-ins. */
export function defineAgent(input: AgentModuleInput): AgentModule {
  const { delegatedBy, tools, resources, prepare, ...definition } = input;
  return {
    definition: AgentDefinitionSchema.parse({
      ...definition,
      model: input.model ?? "powerful",
      capabilities: { skills: [], memory: "none", ...input.capabilities },
    }),
    delegatedBy,
    tools,
    resources,
    prepare,
  };
}

/** Assemble trusted modules without editing worker execution or mutating role constants. */
export function assembleAgentModules(modules: readonly AgentModule[]) {
  const definitions = modules.map((module) => AgentDefinitionSchema.parse(module.definition));
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  if (byId.size !== definitions.length) throw new Error("Agent module IDs must be unique");
  for (const module of modules)
    for (const parentId of module.delegatedBy ?? []) {
      const parent = byId.get(parentId);
      if (!parent) throw new Error(`Unknown delegating agent "${parentId}"`);
      if (parentId === module.definition.id) throw new Error("An agent cannot delegate to itself");
      if (!parent.delegation.agents.includes(module.definition.id))
        parent.delegation.agents.push(module.definition.id);
    }
  return {
    definitions,
    agentTools: Object.fromEntries(
      modules.map((module) => [module.definition.id, module.tools ?? []]),
    ),
    executionResources: modules.flatMap((module) => (module.resources ? [module.resources] : [])),
    prepareAgent: async (id: string) => {
      const module = modules.find((module) => module.definition.id === id);
      if (!module) throw new Error(`Unknown agent module "${id}"`);
      await module.prepare?.();
    },
  };
}
