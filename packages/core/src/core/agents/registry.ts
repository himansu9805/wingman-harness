import { AgentDefinitionSchema, type AgentDefinition } from "./definition";

export type RegisteredAgentDefinition = Readonly<
  Omit<AgentDefinition, "capabilities">
> & {
  readonly capabilities: {
    readonly localTools: "all" | readonly string[];
    readonly mcpTools: "all" | readonly string[];
    readonly skills: "all" | readonly string[];
    readonly memory: AgentDefinition["capabilities"]["memory"];
  };
};

/**
 * Available capability names discovered during application startup.
 * Actual tool implementations remain owned by the runtime.
 */
export interface AgentCapabilitiesCatalog {
  localTools: readonly string[];
  mcpTools: readonly string[];
  skills: readonly string[];
}

/** Stores trusted agent definitions and rejects invalid registrations. */
export class AgentRegistry {
  private readonly definitions = new Map<string, RegisteredAgentDefinition>();

  private readonly available: {
    localTools: ReadonlySet<string>;
    mcpTools: ReadonlySet<string>;
    skills: ReadonlySet<string>;
  };

  constructor(catalogue: AgentCapabilitiesCatalog) {
    this.available = {
      localTools: uniqueNames(catalogue.localTools, "local tools"),
      mcpTools: uniqueNames(catalogue.mcpTools, "MCP tools"),
      skills: uniqueNames(catalogue.skills, "skills"),
    };

    for (const name of this.available.mcpTools) {
      if (this.available.localTools.has(name)) {
        throw new Error(`Tool name "${name}" is shared by local and MCP tools`);
      }
    }
  }

  /**
   * Validates and stores an immutable definition.
   *
   * @throws If the definition is malformed, its ID already exists, or it
   * references capabilities unavailable in this runtime.
   */
  register(input: AgentDefinition): RegisteredAgentDefinition {
    const definition = AgentDefinitionSchema.parse(input);

    if (this.definitions.has(definition.id)) {
      throw new Error(`Agent "${definition.id}" is already registered`);
    }

    const { capabilities } = definition;

    this.validateSelection(
      definition.id,
      "localTools",
      capabilities.localTools,
    );
    this.validateSelection(definition.id, "mcpTools", capabilities.mcpTools);
    this.validateSelection(definition.id, "skills", capabilities.skills);

    const registered = Object.freeze({
      ...definition,
      capabilities: Object.freeze({
        ...capabilities,
        localTools: freezeSelection(capabilities.localTools),
        mcpTools: freezeSelection(capabilities.mcpTools),
        skills: freezeSelection(capabilities.skills),
      }),
    });

    this.definitions.set(registered.id, registered);
    return registered;
  }

  /** Returns a registered agent or rejects an unknown ID. */
  get(id: string): RegisteredAgentDefinition {
    const definition = this.definitions.get(id);

    if (!definition) {
      throw new Error(`Unknown agent "${id}"`);
    }

    return definition;
  }

  /** Returns a new array of immutable registered definitions. */
  list(): readonly RegisteredAgentDefinition[] {
    return [...this.definitions.values()];
  }

  private validateSelection(
    agentId: string,
    category: keyof AgentRegistry["available"],
    selection: "all" | readonly string[],
  ): void {
    if (selection === "all") return;

    for (const name of selection) {
      if (!this.available[category].has(name)) {
        throw new Error(
          `Agent "${agentId}" references unknown ${category} capability "${name}"`,
        );
      }
    }
  }
}

function uniqueNames(
  names: readonly string[],
  category: string,
): ReadonlySet<string> {
  const unique = new Set(names);

  if (unique.size !== names.length) {
    throw new Error(`Duplicate names in ${category} catalogue`);
  }

  return unique;
}

function freezeSelection(
  selection: "all" | string[],
): "all" | readonly string[] {
  return selection === "all" ? selection : Object.freeze([...selection]);
}
