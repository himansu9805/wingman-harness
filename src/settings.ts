import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config();

class Settings {
  readonly BASE_URL: string;
  readonly MODEL_NAME: string;
  readonly SKILLS_DIR: string;
  readonly MCP_CONFIG_PATH: string;

  private readonly BASE_DIR = dirname(fileURLToPath(import.meta.url));

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const { OLLAMA_BASE_URL, OLLAMA_MODEL } = env;

    if (!OLLAMA_BASE_URL || !OLLAMA_MODEL) {
      throw new Error(
        "Missing required environment variables: OLLAMA_BASE_URL and OLLAMA_MODEL",
      );
    }

    this.BASE_URL = OLLAMA_BASE_URL;
    this.MODEL_NAME = OLLAMA_MODEL;
    this.SKILLS_DIR = join(this.BASE_DIR, "..", "skills");
    this.MCP_CONFIG_PATH = join(this.BASE_DIR, "..", "mcp.config.json");
  }
}

export const settings = new Settings();
