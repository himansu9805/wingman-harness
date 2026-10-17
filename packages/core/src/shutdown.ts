import { closeScheduler } from "./scheduler/scheduler";
import { closeMcpTools } from "./mcp/mcp";
import { GraphMemory } from "./memory/graph";
import { closeCheckpointer } from "./core/checkpointer";

let shutdownPromise: Promise<void> | null = null;

/**
 * Releases the scheduler, MCP connections, the checkpointer and the memory
 * graph. Safe to call more than once.
 */
export function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    // Scheduler first, so a finishing scheduled turn can still save its state.
    await closeScheduler();
    await closeMcpTools();
    await closeCheckpointer();
    await GraphMemory.getInstance().closeGraph();
  })();
  return shutdownPromise;
}
