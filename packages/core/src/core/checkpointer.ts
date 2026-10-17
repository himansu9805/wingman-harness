import pg from "pg";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { settings } from "../settings";

let pool: pg.Pool | null = null;

/**
 * Creates the store for conversation state. With Postgres, threads and
 * pending approvals survive restarts; without it they live in memory only.
 *
 * @returns The checkpointer to compile the agent graph with.
 */
export async function createCheckpointer(): Promise<BaseCheckpointSaver> {
  if (!settings.POSTGRES_CONNECTION_STRING) {
    console.warn(
      "[checkpointer] POSTGRES_CONNECTION_STRING is not set; threads are kept in memory only.",
    );
    return new MemorySaver();
  }
  pool = new pg.Pool({ connectionString: settings.POSTGRES_CONNECTION_STRING });
  const saver = new PostgresSaver(pool);
  // Creates the checkpoint tables and runs pending migrations; safe on every start.
  await saver.setup();
  return saver;
}

/**
 * Closes the checkpointer's database connections. Safe to call more than once.
 */
export async function closeCheckpointer(): Promise<void> {
  await pool?.end();
  pool = null;
}