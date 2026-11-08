import type { StructuredToolInterface } from "@langchain/core/tools";

/** Private capability names are visible only to their owning agent. */
export interface PrivateCapabilities {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
}

/** Shared capabilities are available for selection, never automatically granted. */
export interface AgentCapabilitiesCatalog {
  readonly localTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  readonly agents?: Readonly<Record<string, PrivateCapabilities>>;
}

/**
 * Resolves explicit selections against shared and agent-owned tool catalogues.
 * Registering a new global tool does not change any agent's selected tools.
 */
export class AgentToolCatalogue {
  private readonly global: ReadonlyMap<string, StructuredToolInterface>;
  private readonly agents: ReadonlyMap<string, ReadonlyMap<string, StructuredToolInterface>>;

  constructor(
    globalTools: readonly StructuredToolInterface[],
    agentTools: Readonly<Record<string, readonly StructuredToolInterface[]>> = {},
  ) {
    this.global = toolMap(globalTools);
    this.agents = new Map(Object.entries(agentTools).map(([id, tools]) => [id, toolMap(tools)]));
  }

  /** Shared names used to validate opt-in selections during registration. */
  globalNames(): readonly string[] {
    return [...this.global.keys()];
  }

  /** Private names used to validate selections for one owner. */
  privateNames(agentId: string): readonly string[] {
    return [...(this.agents.get(agentId)?.keys() ?? [])];
  }

  /** Returns only selected global tools and selected tools owned by this agent. */
  resolve(
    agentId: string,
    useGlobalTools: readonly string[],
    ownTools: readonly string[],
  ): StructuredToolInterface[] {
    const selected = [
      ...selectTools(this.global, useGlobalTools, "global"),
      ...selectTools(this.agents.get(agentId) ?? new Map(), ownTools, `agent "${agentId}"`),
    ];
    toolMap(selected); // Reject ambiguous names instead of silently overriding a tool.
    return selected;
  }
}

function toolMap(
  tools: readonly StructuredToolInterface[],
): ReadonlyMap<string, StructuredToolInterface> {
  const result = new Map<string, StructuredToolInterface>();
  for (const tool of tools) {
    if (result.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    result.set(tool.name, tool);
  }
  return result;
}

function selectTools(
  available: ReadonlyMap<string, StructuredToolInterface>,
  names: readonly string[],
  scope: string,
): StructuredToolInterface[] {
  return names.map((name) => {
    const tool = available.get(name);
    if (!tool) throw new Error(`Unknown ${scope} tool "${name}"`);
    return tool;
  });
}
