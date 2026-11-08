import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must not read a developer's .env, memory graph, skills or MCP settings.
// Real persistence tests receive their separate connection through TEST_POSTGRES_CONNECTION_STRING.
Object.assign(process.env, {
  WINGMAN_HOME: join(tmpdir(), `wingman-test-home-${process.pid}`),
  SCHEDULER_ENABLED: "false",
  POSTGRES_CONNECTION_STRING: "postgres://test:test@127.0.0.1:1/test",
  DECISIONS_MODEL_BASE_URL: "http://127.0.0.1:1",
  DECISIONS_MODEL_NAME: "test-router",
  DECISIONS_MODEL_API_KEY: "test-only",
  STRONG_MODEL_BASE_URL: "http://127.0.0.1:1",
  STRONG_MODEL_NAME: "test-powerful",
  STRONG_MODEL_API_KEY: "test-only",
  FAST_MODEL_BASE_URL: "http://127.0.0.1:1",
  FAST_MODEL_NAME: "test-fast",
  FAST_MODEL_API_KEY: "test-only",
});
