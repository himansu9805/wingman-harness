import titlesModule from "../../../server/dist/threads/thread-titles.service.js";
import titleGeneratorModule from "../../../server/dist/threads/title-generator.js";
// Disposable local browser-test server: real Nest handlers and approval graph,
// memory-only persistence, no models, shell commands, user credentials or Postgres.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import serviceModule from "../../../server/dist/agent/agent.service.js";
import runtimeModule from "../../../server/dist/agent/agent.runtime.js";
import runnerModule from "../../../server/dist/agent/turn-runner.service.js";
import controllerModule from "../../../server/dist/threads/threads.controller.js";
import tasksControllerModule from "../../../server/dist/tasks/tasks.controller.js";
import guardModule from "../../../server/dist/auth/token.guard.js";
import repositoryModule from "../../../server/dist/threads/thread.repository.js";
import eventsModule from "../../../server/dist/threads/thread-events.repository.js";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { tsImport } from "tsx/esm/api";
const { createDelegationRuntime } = await tsImport(
  "../../../../tests/fixtures/delegation-runtime.mjs",
  import.meta.url,
);
const { commandApproval } = await tsImport(
  "../../../../packages/core/src/conversations/approvals.ts",
  import.meta.url,
);
const demoCheck = tool(
  async ({ command }, runtime) => {
    const approved = interrupt(commandApproval(command, runtime));
    return approved
      ? `Demo result for ${command}: workspace checks passed.`
      : `Declined demo command ${command}.`;
  },
  {
    name: "demo_check",
    description: "Fictional workspace check; never executes a command",
    schema: z.object({ command: z.string() }),
  },
);
const plan = {
  tasks: [
    {
      key: "research",
      agentId: "analyst",
      objective: "Research the workspace",
      context: "Fictional TypeScript workspace",
      expectedResult: "Findings",
      dependsOn: [],
    },
    {
      key: "compare",
      agentId: "analyst",
      objective: "Compare implementation options",
      context: "Fictional project constraints",
      expectedResult: "Comparison",
      dependsOn: [],
    },
    {
      key: "verify",
      agentId: "operator",
      objective: "Verify the findings",
      context: "Use fictional demo checks only",
      expectedResult: "Verification summary",
      dependsOn: ["research", "compare"],
    },
  ],
};
const fixture = await createDelegationRuntime({
  plan,
  operatorTools: [demoCheck],
  summarize: (result) => {
    const plan = JSON.parse(result.text);
    return plan.status === "completed"
      ? "The workspace comparison is complete. TypeScript, NestJS and React remain a good fit. Verification respected your command decisions; see the delegated task results above."
      : `Delegated work needs attention: ${plan.error ?? plan.status}`;
  },
  child: async (messages) => {
    const input = JSON.parse(
      messages.find(HumanMessage.isInstance).text.split("\n").slice(1).join("\n"),
    );
    if (input.agentId === "analyst") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return input.objective.startsWith("Research")
        ? "The workspace uses TypeScript, NestJS and React."
        : "Keep orchestration in core and share capabilities through explicit grants.";
    }
    const results = messages.filter(ToolMessage.isInstance);
    return results.length
      ? `Verification complete: ${results.map((result) => result.text).join(" ")}`
      : [
          { id: "demo-uptime", name: "demo_check", args: { command: "uptime" }, type: "tool_call" },
          {
            id: "demo-status",
            name: "demo_check",
            args: { command: "git status" },
            type: "tool_call",
          },
        ];
  },
});
process.env.WINGMAN_API_TOKEN = "web-development-test-only";
const agent = fixture.agent;
const store = new repositoryModule.MemoryThreadRepository();
const journal = new eventsModule.MemoryThreadEventsRepository(store);
const taskIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
await store.create("demo-schedule-origin");
await store.touch("demo-schedule-origin", "Daily workspace checks");
await store.create("demo-schedule-results");
await store.touch("demo-schedule-results", "Scheduled workspace check");
await agent.app.graph.updateState(
  { configurable: { thread_id: "demo-schedule-results" } },
  {
    messages: [
      new HumanMessage("Demo scheduled task completed successfully."),
      new AIMessage("Workspace checks passed."),
    ],
  },
  "model_request",
);
const demoTasks = new Map([
  [
    taskIds[0],
    {
      id: taskIds[0],
      prompt: "Check workspace health every morning",
      threadId: "demo-schedule-origin",
      nextRunAt: new Date(Date.now() + 3600000).toISOString(),
      repeatInterval: "0 9 * * *",
      state: "repeating",
    },
  ],
  [
    taskIds[1],
    {
      id: taskIds[1],
      prompt: "Generate a project status summary",
      threadId: null,
      nextRunAt: null,
      repeatInterval: null,
      state: "running",
    },
  ],
]);
const demoRuns = [
  {
    id: "2",
    jobId: taskIds[1],
    prompt: "Generate a project status summary",
    threadId: "demo-schedule-results",
    status: "failed",
    output: null,
    error: "Demo upstream service unavailable",
    truncated: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  },
  {
    id: "1",
    jobId: taskIds[0],
    prompt: "Check workspace health every morning",
    threadId: "demo-schedule-origin",
    status: "success",
    output: "Workspace checks passed. No pending actions.",
    error: null,
    truncated: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  },
];
class BrowserTestModule {}
Module({
  controllers: [controllerModule.ThreadsController, tasksControllerModule.TasksController],
  providers: [
    serviceModule.AgentService,
    titlesModule.ThreadTitles,
    {
      provide: titleGeneratorModule.TITLE_GENERATOR,
      useValue: { generate: async () => "Demo conversation" },
    },
    { provide: titlesModule.TITLE_TIMEOUT_MS, useValue: 10000 },
    runnerModule.TurnRunner,
    { provide: repositoryModule.THREAD_REPOSITORY, useValue: store },
    { provide: eventsModule.THREAD_EVENTS, useValue: journal },
    {
      provide: runtimeModule.AGENT_RUNTIME,
      useValue: {
        schedulerEnabled: async () => true,
        scheduledThreadIds: async (ids) =>
          ids.filter((id) => [...demoTasks.values()].some((task) => task.threadId === id)),
        listTasks: async () => ({ items: [...demoTasks.values()], nextBefore: null }),
        cancelTask: async (id) => {
          if (demoTasks.get(id)?.state === "running") {
            const error = new Error("Task is running");
            error.name = "TaskBusyError";
            throw error;
          }
          return demoTasks.delete(id);
        },
        taskRuns: async (_limit, jobId) => ({
          items: demoRuns.filter((run) => !jobId || run.jobId === jobId),
          nextBefore: null,
        }),
        create: async () => agent,
        close: async () => fixture.runtime.close(),
        startScheduler: async () => {},
        stopScheduler: async () => {},
        recordRun: async () => {},
      },
    },
  ],
})(BrowserTestModule);
const app = await NestFactory.create(BrowserTestModule, { logger: false });
app.enableCors({
  origin: "http://127.0.0.1:5173",
  allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
});
app.useGlobalGuards(new guardModule.TokenGuard());
app.enableShutdownHooks();
const port = Number(process.env.WINGMAN_TEST_API_PORT ?? 3001);
await app.listen(port, "127.0.0.1");
console.log(`Disposable test API: http://127.0.0.1:${port}; token: web-development-test-only`);
