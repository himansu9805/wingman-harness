import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config();

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

  private readonly BASE_DIR = dirname(fileURLToPath(import.meta.url));

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const {
      SCHEDULER_ENABLED,
      POSTGRES_CONNECTION_STRING,
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
    };

    const missing = Object.entries(required)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    }

    if (SCHEDULER_ENABLED === "true" && !POSTGRES_CONNECTION_STRING) {
      throw new Error(
        `POSTGRES_CONNECTION_STRING is required when SCHEDULER_ENABLED=${SCHEDULER_ENABLED}`,
      );
    }

    this.SKILLS_DIR = join(this.BASE_DIR, "..", "skills");
    this.MCP_CONFIG_PATH = join(this.BASE_DIR, "..", "mcp.config.json");
    this.GRAPH_DB_PATH = join(this.BASE_DIR, "..", "memory.lbug");
    this.SCHEDULER_ENABLED = SCHEDULER_ENABLED === "true";
    this.POSTGRES_CONNECTION_STRING = "";
    if (this.SCHEDULER_ENABLED === true) {
      this.POSTGRES_CONNECTION_STRING = POSTGRES_CONNECTION_STRING!;
    }
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
