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
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { z } from "zod";

class DemoModel extends BaseChatModel {
  _llmType() {
    return "web-demo";
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const lastUser = messages.findLastIndex(HumanMessage.isInstance);
    const text = messages[lastUser].text;
    const results = messages.slice(lastUser + 1).filter(ToolMessage.isInstance);
    const calls =
      !results.length && text.startsWith("run")
        ? [{ name: "exec_bash_command", args: { command: "uptime" }, id: `command-${lastUser}` }]
        : !results.length && text === "recall memory"
          ? [{ name: "recall_memory", args: { name: "Demo workspace" }, id: `memory-${lastUser}` }]
          : [];
    if (text === "run two" && !results.length)
      calls.push({
        name: "exec_bash_command",
        args: { command: "pwd" },
        id: `second-command-${lastUser}`,
      });
    const message = new AIMessage({
      content: calls.length
        ? ""
        : results.length
          ? results.map((result) => result.text).join(", ")
          : text,
      tool_calls: calls,
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
    return { generations: [{ text: message.text, message }] };
  }
}
const command = tool(
  async ({ command }) => {
    const approved = interrupt({ kind: "bash_approval", command });
    return approved === true ? "Demo uptime: 3 hours, 28 minutes." : "Command declined.";
  },
  {
    name: "exec_bash_command",
    description: "Harmless demo command; never executes a process.",
    schema: z.object({ command: z.string() }),
  },
);
const recall = tool(async () => "Demo workspace uses TypeScript and React.", {
  name: "recall_memory",
  description: "Return fictional demo facts.",
  schema: z.object({ name: z.string() }),
});

process.env.WINGMAN_API_TOKEN = "web-development-test-only";
const agent = {
  app: createAgent({
    model: new DemoModel({}),
    tools: [command, recall],
    checkpointer: new MemorySaver(),
  }),
};
const store = new repositoryModule.MemoryThreadRepository();
const journal = new eventsModule.MemoryThreadEventsRepository(store);
const originalStream = agent.app.stream.bind(agent.app);
agent.app.stream = async (input, options) => {
  const request = input?.messages?.[0]?.text;
  if (request === "slow") await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (request === "fail") throw new Error("Deterministic browser-test error");
  return (async function* () {
    yield {
      "TypeSafeModelRouterMiddleware.before_agent": {
        modelRoute: {
          choice: "fast",
          confidence: 0,
          probabilities: { fast: 0.5153, powerful: 0.4847 },
        },
      },
    };
    yield* await originalStream(input, options);
  })();
};
const taskIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
await store.create("demo-schedule-origin");
await store.touch("demo-schedule-origin", "Daily workspace checks");
await store.create("demo-schedule-results");
await store.touch("demo-schedule-results", "Scheduled workspace check");
await agent.app.invoke(
  { messages: [new HumanMessage("Demo scheduled task completed successfully.")] },
  { configurable: { thread_id: "demo-schedule-results" } },
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
        close: async () => {},
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
