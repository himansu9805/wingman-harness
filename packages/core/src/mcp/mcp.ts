import { readFile } from "node:fs/promises";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { settings } from "../settings";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
}

let cachedClient: MultiServerMCPClient | null = null;
let cachedToolsPromise: Promise<StructuredToolInterface[]> | null = null;

/**
 * Reads the MCP server configuration from the configured file.
 *
 * Missing or invalid configuration files are treated as empty configurations.
 *
 * @returns The configured MCP servers, or an empty server map when unavailable.
 */
async function readConfig(): Promise<McpConfig> {
  try {
    const raw = await readFile(settings.MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as McpConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[mcp] Could not read mcp.config.json: ${(err as Error).message}`,
      );
    }
    return { mcpServers: {} };
  }
}

/**
 * Loads tools from every configured MCP server.
 *
 * Servers that fail to connect are logged and skipped.
 *
 * @returns The configured MCP tools as LangChain-compatible tools.
 */
export function loadMcpTools(): Promise<StructuredToolInterface[]> {
  if (cachedToolsPromise) return cachedToolsPromise;

  cachedToolsPromise = (async () => {
    const config = await readConfig();
    const servers = config.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      return [];
    }

    cachedClient = new MultiServerMCPClient({ mcpServers: servers as never });
    try {
      return await cachedClient.getTools();
    } catch (err) {
      console.warn(`[mcp] Failed to load MCP tools: ${(err as Error).message}`);
      return [];
    }
  })();

  return cachedToolsPromise;
}

/**
 * Closes all MCP server connections.
 *
 * @returns A promise that resolves when all connections are closed.
 */
export async function closeMcpTools(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
  }
}
