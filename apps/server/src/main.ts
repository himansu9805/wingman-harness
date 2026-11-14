import "reflect-metadata";
// Load the shared .env before constructing the token guard.
import "@wingman/core";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { TokenGuard } from "./auth/token.guard";
import { AgentService } from "./agent/agent.service";
import { attachSandboxWebSocket } from "./sandboxes/sandbox-websocket";
import { attachThreadEventsWebSocket } from "./threads/thread-events-websocket";

/**
 * Starts the API on localhost; shell commands run in Docker sandboxes.
 * The root .env is loaded when AppModule imports @wingman/core.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  app.useGlobalGuards(new TokenGuard());
  app.enableShutdownHooks();
  await app.init();
  const agent = app.get(AgentService);
  attachSandboxWebSocket(
    app.getHttpServer(),
    () => agent.sandboxMonitor,
    process.env.WINGMAN_API_TOKEN ?? "",
    agent.shutdownSignal,
    process.env.WEB_ORIGIN ?? "http://localhost:5173",
  );
  attachThreadEventsWebSocket(
    app.getHttpServer(),
    agent,
    process.env.WINGMAN_API_TOKEN ?? "",
    process.env.WEB_ORIGIN ?? "http://localhost:5173",
  );
  await app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
}

bootstrap();
