// Disposable local browser-test server: real Nest handlers and approval graph,
// memory-only persistence, no models, shell commands, user credentials or Postgres.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import serviceModule from '../../../server/dist/agent/agent.service.js';
import runtimeModule from '../../../server/dist/agent/agent.runtime.js';
import runnerModule from '../../../server/dist/agent/turn-runner.service.js';
import controllerModule from '../../../server/dist/threads/threads.controller.js';
import guardModule from '../../../server/dist/auth/token.guard.js';
import repositoryModule from '../../../server/dist/threads/thread.repository.js';
import eventsModule from '../../../server/dist/threads/thread-events.repository.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver, interrupt } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';

class DemoModel extends BaseChatModel {
  _llmType() { return 'web-demo'; }
  bindTools() { return this; }
  async _generate(messages) {
    const lastUser = messages.findLastIndex(HumanMessage.isInstance);
    const text = messages[lastUser].text;
    const results = messages.slice(lastUser + 1).filter(ToolMessage.isInstance);
    const calls = !results.length && text.startsWith('run') ? [{ name: 'exec_bash_command', args: { command: 'uptime' }, id: `command-${lastUser}` }]
      : !results.length && text === 'recall memory' ? [{ name: 'recall_memory', args: { name: 'Demo workspace' }, id: `memory-${lastUser}` }] : [];
    const message = new AIMessage({ content: calls.length ? '' : results.length ? results.map(result => result.text).join(', ') : text, tool_calls: calls });
    return { generations: [{ text: message.text, message }] };
  }
}
const command = tool(async ({ command }) => {
  const approved = interrupt({ kind: 'bash_approval', command });
  return approved === true ? 'Demo uptime: 3 hours, 28 minutes.' : 'Command declined.';
}, { name: 'exec_bash_command', description: 'Harmless demo command; never executes a process.', schema: z.object({ command: z.string() }) });
const recall = tool(async () => 'Demo workspace uses TypeScript and React.', {
  name: 'recall_memory', description: 'Return fictional demo facts.', schema: z.object({ name: z.string() }),
});

process.env.WINGMAN_API_TOKEN = 'web-development-test-only';
const agent = { app: createAgent({ model: new DemoModel({}), tools: [command, recall], checkpointer: new MemorySaver() }) };
const store = new repositoryModule.MemoryThreadRepository();
const journal = new eventsModule.MemoryThreadEventsRepository(store);
const originalStream = agent.app.stream.bind(agent.app);
agent.app.stream = async (input, options) => {
  const request = input?.messages?.[0]?.text;
  if (request === 'slow') await new Promise(resolve => setTimeout(resolve, 3_000));
  if (request === 'fail') throw new Error('Deterministic browser-test error');
  return (async function* () {
    yield { 'TypeSafeModelRouterMiddleware.before_agent': { modelRoute: { choice: 'fast', confidence: 0, probabilities: { fast: 0.5153, powerful: 0.4847 } } } };
    yield* await originalStream(input, options);
  })();
};
class BrowserTestModule {}
Module({ controllers: [controllerModule.ThreadsController], providers: [
  serviceModule.AgentService, runnerModule.TurnRunner,
  { provide: repositoryModule.THREAD_REPOSITORY, useValue: store },
  { provide: eventsModule.THREAD_EVENTS, useValue: journal },
  { provide: runtimeModule.AGENT_RUNTIME, useValue: { create: async () => agent, close: async () => {}, startScheduler: async () => {}, stopScheduler: async () => {}, recordRun: async () => {} } },
] })(BrowserTestModule);
const app = await NestFactory.create(BrowserTestModule, { logger: false });
app.enableCors({ origin: 'http://127.0.0.1:5173', allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'] });
app.useGlobalGuards(new guardModule.TokenGuard());
app.enableShutdownHooks();
const port = Number(process.env.WINGMAN_TEST_API_PORT ?? 3001);
await app.listen(port, '127.0.0.1');
console.log(`Disposable test API: http://127.0.0.1:${port}; token: web-development-test-only`);
