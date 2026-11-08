import { readFile } from "node:fs/promises";
import { MultiServerMCPClient, type Connection } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { McpGrantsSchema, McpServerIdSchema, type RegisteredMcpGrant } from "./grants";

/** The subset of the adapter used by connection ownership and discovery. */
export interface McpClient {
  getTools(): Promise<StructuredToolInterface[]>;
  close(): Promise<void>;
}

/** Explicit global selections plus selections from the owning agent's profiles. */
export interface McpAccess {
  readonly useGlobalMcpServers: readonly RegisteredMcpGrant[];
  readonly mcp: readonly RegisteredMcpGrant[];
}

/** Agent-facing access to profile-scoped tools; connection settings stay private. */
export interface McpConnections {
  readonly serverIds: readonly string[];
  privateServerIds(agentId: string): readonly string[];
  getTools(agentId: string, access: McpAccess): Promise<StructuredToolInterface[]>;
  close(): Promise<void>;
}

export type McpClientFactory = (serverId: string, configuration: unknown) => McpClient;

const configSchema = z
  .object({
    mcpServers: z.record(McpServerIdSchema, z.unknown()).default({}),
    agents: z
      .record(
        McpServerIdSchema,
        z
          .object({
            mcpServers: z.record(McpServerIdSchema, z.unknown()).default({}),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

function createClient(serverId: string, configuration: unknown): McpClient {
  // The adapter constructor validates the transport configuration at this boundary.
  return new MultiServerMCPClient({
    mcpServers: { [serverId]: configuration as Connection },
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    throwOnLoadError: true,
    onConnectionError: "throw",
  });
}

interface LoadedProfile {
  client: McpClient;
  tools: Promise<ReadonlyMap<string, StructuredToolInterface>>;
}

/**
 * Lazily opens shared profiles once and private profiles once per owning agent.
 * Separate profile IDs always use separate clients, even for identical URLs.
 * Use separate profiles when credentials or session state must be isolated.
 */
export class McpConnectionManager implements McpConnections {
  readonly serverIds: readonly string[];
  private readonly profiles: ReadonlyMap<string, unknown>;
  private readonly privateProfiles = new Map<string, readonly string[]>();
  private readonly loaded = new Map<string, LoadedProfile>();
  private closing?: Promise<void>;

  constructor(
    configuration: unknown,
    private readonly clientFactory: McpClientFactory = createClient,
  ) {
    const parsed = configSchema.safeParse(configuration);
    if (!parsed.success)
      throw new Error("Invalid MCP configuration; check server profiles and IDs");
    const profiles = new Map<string, unknown>();
    for (const [id, configuration] of Object.entries(parsed.data.mcpServers)) {
      profiles.set(`global__${id}`, configuration);
    }
    this.serverIds = Object.freeze(Object.keys(parsed.data.mcpServers));
    for (const [agentId, own] of Object.entries(parsed.data.agents)) {
      this.privateProfiles.set(agentId, Object.freeze(Object.keys(own.mcpServers)));
      for (const [id, configuration] of Object.entries(own.mcpServers)) {
        profiles.set(`agent__${agentId}__${id}`, configuration);
      }
    }
    this.profiles = profiles;
  }

  /** Lists private profile IDs without exposing another agent's profiles. */
  privateServerIds(agentId: string): readonly string[] {
    return this.privateProfiles.get(agentId) ?? [];
  }

  /**
   * Resolves explicitly selected global profiles and profiles owned by this agent.
   * Empty selections grant no access and open no connections. Names include
   * global or agent scope, so private profiles never override shared profiles.
   */
  async getTools(agentId: string, access: McpAccess): Promise<StructuredToolInterface[]> {
    if (this.closing) throw new Error("MCP connections are closing");
    McpServerIdSchema.parse(agentId);
    const global = McpGrantsSchema.parse(access.useGlobalMcpServers);
    const own = McpGrantsSchema.parse(access.mcp);
    const grants = [
      ...global.map((grant) => ({ ...grant, profileId: `global__${grant.serverId}` })),
      ...own.map((grant) => ({ ...grant, profileId: `agent__${agentId}__${grant.serverId}` })),
    ];
    for (const grant of grants) {
      if (!this.profiles.has(grant.profileId)) {
        throw new Error(
          `Unknown MCP server "${grant.serverId}" in requested scope for agent "${agentId}"`,
        );
      }
    }
    const selected = await Promise.all(
      grants.map(async (grant) => {
        if (grant.tools !== "all" && grant.tools.length === 0) return [];
        const tools = await this.loadProfile(grant.profileId);
        if (grant.tools === "all") return [...tools.values()];
        return grant.tools.map((name) => {
          const selected = tools.get(name);
          if (!selected)
            throw new Error(`Unknown MCP tool "${name}" on server "${grant.serverId}"`);
          return selected;
        });
      }),
    );
    if (this.closing) throw new Error("MCP connections are closing");
    return selected.flat();
  }

  /** Waits for pending discovery, then attempts every opened client's cleanup once. */
  close(): Promise<void> {
    return (this.closing ??= this.closeClients());
  }

  private loadProfile(serverId: string): Promise<ReadonlyMap<string, StructuredToolInterface>> {
    const existing = this.loaded.get(serverId);
    if (existing) return existing.tools;

    let client: McpClient;
    try {
      client = this.clientFactory(serverId, this.profiles.get(serverId));
    } catch {
      // Adapter errors can include connection settings, headers or credentials.
      throw new Error(`Invalid MCP connection configuration for server "${serverId}"`);
    }
    const tools = (async () => {
      let discovered: StructuredToolInterface[];
      try {
        discovered = await client.getTools();
      } catch {
        throw new Error(`Failed to discover tools for MCP server "${serverId}"`);
      }
      const prefix = `mcp__${serverId}__`;
      const available = new Map<string, StructuredToolInterface>();
      for (const tool of discovered) {
        if (!tool.name.startsWith(prefix) || tool.name.length === prefix.length) {
          throw new Error(`Invalid tool namespace from MCP server "${serverId}"`);
        }
        const name = tool.name.slice(prefix.length);
        if (available.has(name))
          throw new Error(`Duplicate MCP tool "${name}" on server "${serverId}"`);
        available.set(name, tool);
      }
      return available;
    })();
    this.loaded.set(serverId, { client, tools });
    return tools;
  }

  private async closeClients(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.loaded].map(async ([serverId, profile]) => {
        // Discovery failures must not prevent closing a partially opened client.
        await profile.tools.catch(() => undefined);
        try {
          await profile.client.close();
        } catch {
          throw new Error(`Failed to close MCP server "${serverId}"`);
        }
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "MCP connection cleanup failed");
  }
}

/** Missing configuration means no MCP servers; unreadable or malformed files fail explicitly. */
export async function openMcpConnections(path: string): Promise<McpConnections> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new McpConnectionManager({});
    throw new Error("Could not read MCP configuration file");
  }
  let configuration: unknown;
  try {
    configuration = JSON.parse(raw);
  } catch {
    throw new Error("MCP configuration file contains invalid JSON");
  }
  return new McpConnectionManager(configuration);
}
