import { AgentDefinitionSchema, type AgentDefinition } from "./definition";
import { McpServerIdSchema, type RegisteredMcpGrant } from "../../mcp/grants";
import type { AgentCapabilitiesCatalog } from "./catalogue";
import { MEMORY_TOOL_NAMES } from "../../tools/names";
export type { AgentCapabilitiesCatalog } from "./catalogue";

export type RegisteredAgentDefinition = Readonly<
  Omit<AgentDefinition, "capabilities" | "delegation">
> & {
  readonly delegation: { readonly agents: readonly string[]; readonly timeoutMs: number };
  readonly capabilities: {
    readonly useGlobalTools: readonly string[];
    readonly tools: readonly string[];
    readonly useGlobalMcpServers: readonly RegisteredMcpGrant[];
    readonly mcp: readonly RegisteredMcpGrant[];
    readonly skills: "all" | readonly string[];
    readonly memory: AgentDefinition["capabilities"]["memory"];
  };
};

/** Stores trusted agent definitions and rejects invalid registrations. */
export class AgentRegistry {
  private readonly definitions = new Map<string, RegisteredAgentDefinition>();

  private readonly available: {
    localTools: ReadonlySet<string>;
    mcpServers: ReadonlySet<string>;
    skills: ReadonlySet<string>;
  };

  private readonly agents: ReadonlyMap<string, {
    tools: ReadonlySet<string>;
    mcpServers: ReadonlySet<string>;
  }>;

  constructor(catalogue: AgentCapabilitiesCatalog) {
    this.available = {
      localTools: uniqueNames(catalogue.localTools, "local tools"),
      mcpServers: uniqueNames(
        catalogue.mcpServers.map(id => McpServerIdSchema.parse(id)),
        "MCP servers",
      ),
      skills: uniqueNames(catalogue.skills, "skills"),
    };
    this.agents = new Map(
      Object.entries(catalogue.agents ?? {}).map(([id, own]) => [id, {
        tools: uniqueNames(own.tools, `agent "${id}" tools`),
        mcpServers: uniqueNames(
          own.mcpServers.map(name => McpServerIdSchema.parse(name)),
          `agent "${id}" MCP servers`,
        ),
      }]),
    );
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
      definition.id, "localTools", capabilities.useGlobalTools,
    );
    this.validateSelection(definition.id, "skills", capabilities.skills);
    const selectedTools = [...capabilities.useGlobalTools, ...capabilities.tools];
    if (definition.delegation.agents.length && !capabilities.tools.includes("delegate_task")) {
      throw new Error(`Agent "${definition.id}" must select its private delegate_task tool`);
    }
    if (selectedTools.includes("delegate_task") && !definition.delegation.agents.length) {
      throw new Error(`Agent "${definition.id}" has no permitted delegation targets`);
    }
    for (const name of selectedTools) {
      if (MEMORY_TOOL_NAMES.has(name) && (
        capabilities.memory === "none" ||
        (capabilities.memory === "read" && name !== "recall_memory")
      )) {
        throw new Error(`Agent "${definition.id}" cannot use "${name}" with memory policy "${capabilities.memory}"`);
      }
    }
    const hasSkills = capabilities.skills === "all" ? this.available.skills.size > 0 : capabilities.skills.length > 0;
    if (hasSkills && !selectedTools.includes("load_skill")) {
      throw new Error(`Agent "${definition.id}" must select load_skill to use skills`);
    }
    if (!hasSkills && capabilities.skills !== "all" && selectedTools.includes("load_skill")) {
      throw new Error(`Agent "${definition.id}" selected load_skill without any permitted skills`);
    }
    const own = this.agents.get(definition.id);
    for (const name of capabilities.tools) {
      if (!own?.tools.has(name)) {
        throw new Error(`Unknown private tool "${name}" for agent "${definition.id}"`);
      }
      if (capabilities.useGlobalTools.includes(name)) {
        throw new Error(`Duplicate agent tool name "${name}"`);
      }
    }
    for (const [grants, available, scope] of [
      [capabilities.useGlobalMcpServers, this.available.mcpServers, "global"],
      [capabilities.mcp, own?.mcpServers ?? new Set<string>(), "private"],
    ] as const) {
      for (const grant of grants) {
        if (!available.has(grant.serverId)) {
          throw new Error(
            `Agent "${definition.id}" references unknown ${scope} MCP server "${grant.serverId}"`,
          );
        }
      }
    }

    const registered = Object.freeze({
      ...definition,
      delegation: Object.freeze({ ...definition.delegation, agents: Object.freeze([...definition.delegation.agents]) }),
      capabilities: Object.freeze({
        ...capabilities,
        useGlobalTools: Object.freeze([...capabilities.useGlobalTools]),
        tools: Object.freeze([...capabilities.tools]),
        useGlobalMcpServers: freezeGrants(capabilities.useGlobalMcpServers),
        mcp: freezeGrants(capabilities.mcp),
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
    category: "localTools" | "skills",
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

function freezeGrants(
  grants: readonly RegisteredMcpGrant[],
): readonly RegisteredMcpGrant[] {
  return Object.freeze(grants.map(grant => Object.freeze({
    serverId: grant.serverId,
    tools: grant.tools === "all" ? "all" : Object.freeze([...grant.tools]),
  })));
}
