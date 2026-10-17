import { config } from "dotenv";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where .env, skills/, mcp.config.json and memory.lbug live. Both
 * src/settings.ts and dist/index.js sit two folders below the package, so
 * three levels up is the repo root either way.
 */
const HOME =
  process.env.WINGMAN_HOME ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

config({ path: join(HOME, ".env") });

class Settings {
  readonly SKILLS_DIR: string;
  readonly MCP_CONFIG_PATH: string;
  readonly GRAPH_DB_PATH: string;
  readonly SCHEDULER_ENABLED: boolean;
  readonly POSTGRES_CONNECTION_STRING: string;

  readonly DECISIONS_MODEL_BASE_URL: string;
  readonly DECISIONS_MODEL_NAME: string;
  readonly DECISIONS_MODEL_API_KEY: string;
  readonly STRONG_MODEL_BASE_URL: string;
  readonly STRONG_MODEL_NAME: string;
  readonly STRONG_MODEL_API_KEY: string;
  readonly FAST_MODEL_BASE_URL: string;
  readonly FAST_MODEL_NAME: string;
  readonly FAST_MODEL_API_KEY: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const {
      SCHEDULER_ENABLED,
      POSTGRES_CONNECTION_STRING = "",
      DECISIONS_MODEL_BASE_URL = "",
      DECISIONS_MODEL_NAME = "",
      DECISIONS_MODEL_API_KEY = "",
      STRONG_MODEL_BASE_URL = "",
      STRONG_MODEL_NAME = "",
      STRONG_MODEL_API_KEY = "",
      FAST_MODEL_BASE_URL = "",
      FAST_MODEL_NAME = "",
      FAST_MODEL_API_KEY = "",
    } = env;

    const required = {
      DECISIONS_MODEL_BASE_URL,
      DECISIONS_MODEL_NAME,
      DECISIONS_MODEL_API_KEY,
      STRONG_MODEL_NAME,
      FAST_MODEL_BASE_URL,
      FAST_MODEL_NAME,
      POSTGRES_CONNECTION_STRING,
    };

    const missing = Object.entries(required)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    }

    this.SKILLS_DIR = join(HOME, "skills");
    this.MCP_CONFIG_PATH = join(HOME, "mcp.config.json");
    this.GRAPH_DB_PATH = join(HOME, "memory.lbug");
    this.SCHEDULER_ENABLED = SCHEDULER_ENABLED === "true";
    this.POSTGRES_CONNECTION_STRING = POSTGRES_CONNECTION_STRING ?? "";
    this.DECISIONS_MODEL_BASE_URL = DECISIONS_MODEL_BASE_URL;
    this.DECISIONS_MODEL_NAME = DECISIONS_MODEL_NAME;
    this.DECISIONS_MODEL_API_KEY = DECISIONS_MODEL_API_KEY;
    this.STRONG_MODEL_BASE_URL = STRONG_MODEL_BASE_URL;
    this.STRONG_MODEL_NAME = STRONG_MODEL_NAME;
    this.STRONG_MODEL_API_KEY = STRONG_MODEL_API_KEY;
    this.FAST_MODEL_BASE_URL = FAST_MODEL_BASE_URL;
    this.FAST_MODEL_NAME = FAST_MODEL_NAME;
    this.FAST_MODEL_API_KEY = FAST_MODEL_API_KEY;
  }
}

export const settings = new Settings();
