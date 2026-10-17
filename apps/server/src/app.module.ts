import { Module } from "@nestjs/common";
import { AgentService } from "./agent/agent.service";
import { ThreadsController } from "./threads/threads.controller";

@Module({
  controllers: [ThreadsController],
  providers: [AgentService],
})
export class AppModule {}
