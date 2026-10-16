import { closeScheduler } from "./scheduler/scheduler";
import { closeMcpTools } from "./mcp/mcp";
import { GraphMemory } from "./memory/graph";

let shutdownPromise: Promise<void> | null = null;

/**
 * Releases the scheduler, MCP connections and the memory graph. Safe to call
 * more than once.
 */
export function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await closeScheduler();
    await closeMcpTools();
    await GraphMemory.getInstance().closeGraph();
  })();
  return shutdownPromise;
}
