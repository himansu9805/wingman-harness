import { TasksController } from "./tasks/tasks.controller";
import { TurnRunner } from "./agent/turn-runner.service";
import { THREAD_EVENTS, PostgresThreadEventsRepository } from "./threads/thread-events.repository";
import { Module } from "@nestjs/common";
import { AgentService } from "./agent/agent.service";
import { ThreadsController } from "./threads/threads.controller";
import { AGENT_RUNTIME, agentRuntime } from "./agent/agent.runtime";

import { THREAD_REPOSITORY, PostgresThreadRepository } from "./threads/thread.repository";

@Module({
  controllers: [ThreadsController, TasksController],
  providers: [
    AgentService,
    TurnRunner,
    { provide: THREAD_EVENTS, useFactory: () => new PostgresThreadEventsRepository(process.env.POSTGRES_CONNECTION_STRING ?? "") },
    { provide: AGENT_RUNTIME, useValue: agentRuntime },
    {
      provide: THREAD_REPOSITORY,
      useFactory: () => new PostgresThreadRepository(process.env.POSTGRES_CONNECTION_STRING ?? ""),
    },
  ],
})
export class AppModule {}
