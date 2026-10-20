import "reflect-metadata";
// Load the shared .env before constructing the token guard.
import "@wingman/core";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { TokenGuard } from "./auth/token.guard";

/**
 * Starts the API on localhost only: it can run shell commands on this machine.
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
  await app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
}

bootstrap();
