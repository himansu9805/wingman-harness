import { createHash } from "node:crypto";
import type pg from "pg";

const AEROSPACE_NAMES = [
  "Falcon",
  "Raptor",
  "Viper",
  "Hawkeye",
  "Skyhawk",
  "Hornet",
  "Harrier",
  "Kestrel",
  "Merlin",
  "Osprey",
  "Phantom",
  "Raven",
  "Talon",
  "Valkyrie",
  "Voyager",
  "Orion",
  "Apollo",
  "Artemis",
  "Pegasus",
  "Comet",
  "Aurora",
  "Cosmos",
  "Zenith",
  "Eagle",
] as const;

/** Keep a recognizable sandbox identity across container replacements and removals. */
export function sandboxName(threadId: string): string {
  const hash = createHash("sha256").update(threadId).digest();
  const name = AEROSPACE_NAMES[hash.readUInt32BE(0) % AEROSPACE_NAMES.length];
  return `${name}-${hash.toString("hex").slice(8, 20)}`;
}

/** Create and migrate persisted sandbox metadata before the executor starts. */
export async function initializeSandboxStorage(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS wingman_docker_sessions (
      thread_id TEXT PRIMARY KEY,
      container_name TEXT NOT NULL UNIQUE,
      sandbox_name TEXT NOT NULL,
      owner_token UUID NOT NULL,
      container_id TEXT UNIQUE,
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expired_at TIMESTAMPTZ,
      recovery_reason TEXT,
      shell_session_id UUID,
      shell_uncertain BOOLEAN NOT NULL DEFAULT false
    )`);
  await pool.query(
    "ALTER TABLE wingman_docker_sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS recovery_reason TEXT, ADD COLUMN IF NOT EXISTS shell_session_id UUID, ADD COLUMN IF NOT EXISTS shell_uncertain BOOLEAN NOT NULL DEFAULT false",
  );
  await pool.query(
    "ALTER TABLE wingman_docker_sessions ADD COLUMN IF NOT EXISTS sandbox_name TEXT",
  );
  const existing = await pool.query<{ thread_id: string }>(
    "SELECT thread_id FROM wingman_docker_sessions WHERE sandbox_name IS NULL",
  );
  for (const row of existing.rows) {
    await pool.query(
      "UPDATE wingman_docker_sessions SET sandbox_name=$2 WHERE thread_id=$1 AND sandbox_name IS NULL",
      [row.thread_id, sandboxName(row.thread_id)],
    );
  }
  await pool.query("ALTER TABLE wingman_docker_sessions ALTER COLUMN sandbox_name SET NOT NULL");
}
