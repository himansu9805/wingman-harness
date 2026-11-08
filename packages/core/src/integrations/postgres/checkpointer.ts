import pg from "pg";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { settings } from "../../settings";

/** A checkpoint saver and the cleanup handle owned by its runtime. */
export interface CheckpointStore {
  saver: BaseCheckpointSaver;
  /** Closes owned connections once; the in-memory store requires no cleanup. */
  close(): Promise<void>;
}

/**
 * Creates the store for conversation state. With Postgres, threads and
 * pending approvals survive restarts; without it they live in memory only.
 *
 * @returns The saver and an idempotent connection cleanup handle.
 * @throws If setup fails, after attempting to close the newly created pool.
 */
export async function createCheckpointer(): Promise<CheckpointStore> {
  if (!settings.POSTGRES_CONNECTION_STRING) {
    console.warn(
      "[checkpointer] POSTGRES_CONNECTION_STRING is not set; threads are kept in memory only.",
    );
    return {
      saver: new MemorySaver(),
      close: async () => {},
    };
  }
  const pool = new pg.Pool({
    connectionString: settings.POSTGRES_CONNECTION_STRING,
  });
  const saver = new PostgresSaver(pool);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    return (closing ??= pool.end());
  };
  // Creates the checkpoint tables and runs pending migrations; safe on every start.
  try {
    await saver.setup();
    return { saver, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Checkpoint initialization and cleanup failed",
      );
    }
    throw error;
  }
}
