import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config();

class Settings {
  readonly MODEL_PROVIDER: string;
  readonly BASE_URL: string;
  readonly MODEL_NAME: string;
  readonly API_KEY: string;
  readonly SKILLS_DIR: string;
  readonly MCP_CONFIG_PATH: string;
  readonly GRAPH_DB_PATH: string;
  readonly SCHEDULER_ENABLED: boolean;
  readonly POSTGRES_CONNECTION_STRING: string;

  private readonly BASE_DIR = dirname(fileURLToPath(import.meta.url));

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const {
      MODEL_PROVIDER,
      BASE_URL,
      MODEL_NAME,
      API_KEY,
      SCHEDULER_ENABLED,
      POSTGRES_CONNECTION_STRING,
    } = env;

    if (!MODEL_PROVIDER || !MODEL_NAME) {
      throw new Error(
        "Missing required environment variables: MODEL_PROVIDER and MODEL_NAME",
      );
    }
    // OpenAI needs a key but no base URL; Ollama needs a base URL but no key.
    if (MODEL_PROVIDER === "OPENAI" && !API_KEY) {
      throw new Error("API_KEY is required when MODEL_PROVIDER=OPENAI");
    }
    if (MODEL_PROVIDER !== "OPENAI" && !BASE_URL) {
      throw new Error(
        `BASE_URL is required when MODEL_PROVIDER=${MODEL_PROVIDER}`,
      );
    }
    if (SCHEDULER_ENABLED === "true" && !POSTGRES_CONNECTION_STRING) {
      throw new Error(
        `POSTGRES_CONNECTION_STRING is required when SCHEDULER_ENABLED=${SCHEDULER_ENABLED}`,
      );
    }

    this.MODEL_PROVIDER = MODEL_PROVIDER;
    this.BASE_URL = BASE_URL ?? "";
    this.MODEL_NAME = MODEL_NAME;
    // The OpenAI client rejects an empty key; Ollama ignores whatever is sent.
    this.API_KEY = API_KEY || "ollama";
    this.SKILLS_DIR = join(this.BASE_DIR, "..", "skills");
    this.MCP_CONFIG_PATH = join(this.BASE_DIR, "..", "mcp.config.json");
    this.GRAPH_DB_PATH = join(this.BASE_DIR, "..", "memory.lbug");
    this.SCHEDULER_ENABLED = SCHEDULER_ENABLED === "true";
    this.POSTGRES_CONNECTION_STRING = "";
    if (this.SCHEDULER_ENABLED === true) {
      this.POSTGRES_CONNECTION_STRING = POSTGRES_CONNECTION_STRING!;
    }
  }
}

export const settings = new Settings();
