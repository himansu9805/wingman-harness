import { Module } from "@nestjs/common";
import { AgentService } from "./agent/agent.service";
import { ThreadsController } from "./threads/threads.controller";
import { AGENT_RUNTIME, agentRuntime } from "./agent/agent.runtime";

@Module({
  controllers: [ThreadsController],
  providers: [AgentService, { provide: AGENT_RUNTIME, useValue: agentRuntime }],
})
export class AppModule {}
