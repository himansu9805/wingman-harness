import '../setup.mjs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { CoreRuntime } from '../../packages/core/src/core/runtime.ts';
import { Agent } from '../../packages/core/src/core/agent.ts';
import { createDefaultAgentDefinition, analystAgentDefinition } from '../../packages/core/src/core/agents/defaults.ts';
import { createLocalTools } from '../../packages/core/src/tools/tools.ts';
import { MemoryDelegationStore } from '../../packages/core/src/core/delegation/store.ts';

class DelegationModel extends BaseChatModel {
  constructor(trace, child, args, boundTools = []) { super({}); Object.assign(this, { trace, child, args, boundTools }); }
  _llmType() { return 'durable-delegation-test'; }
  bindTools(tools) { return new DelegationModel(this.trace, this.child, this.args, tools); }
  async _generate(messages, options) {
    const prompt = messages.filter(SystemMessage.isInstance).map(message => message.text).join('\n');
    const child = prompt.includes('# Agent: analyst');
    this.trace.calls.push({ child, messages, prompt, tools: this.boundTools.map(tool => tool.name) });
    let response;
    if (child) response = await this.child(messages, options);
    else {
      const lastUser = messages.findLastIndex(HumanMessage.isInstance);
      const result = messages.slice(lastUser + 1).find(ToolMessage.isInstance);
      response = result ? `Coordinator: ${result.text}` : messages[lastUser].text.startsWith('simple') ? 'Direct response' : [{
        id: 'delegate-call', name: 'delegate_task', args: this.args, type: 'tool_call',
      }];
    }
    const message = new AIMessage({
      content: Array.isArray(response) ? '' : response,
      tool_calls: Array.isArray(response) ? response : [],
      usage_metadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    return { generations: [{ text: message.text, message }] };
  }
}

export async function createDelegationRuntime({
  store = new MemoryDelegationStore(), saver = new MemorySaver(),
  child = async () => 'Specialist analysis', timeoutMs = 30000,
  args = { agentId: 'analyst', objective: 'Compare supplied options', context: 'Only this scoped context' },
} = {}) {
  const trace = { calls: [], memory: 0 };
  const model = new DelegationModel(trace, child, args);
  const definition = createDefaultAgentDefinition();
  definition.delegation.timeoutMs = timeoutMs;
  const runtime = await CoreRuntime.create({
    async openMcp() { return { serverIds: [], privateServerIds() { return []; }, async getTools() { return []; }, async close() {} }; },
    async loadSkills() { return []; },
    async loadConfiguration() { return {
      definitions: [definition, analystAgentDefinition], globalTools: createLocalTools([]),
      models: { fast: model, powerful: model, routingMiddleware: createMiddleware({ name: 'TestRouter', wrapModelCall: (request, handler) => handler(request) }) },
    }; },
    async openCheckpointer() { return { saver, async close() {} }; },
    async openDelegations() { return store; },
    async readSkill() { throw new Error('No skills granted'); },
    async getMemoryIndex() { trace.memory++; return 'ROOT PRIVATE MEMORY'; },
    async stopScheduler() {}, async closeResults() {}, async closeMemory() {},
  });
  return { runtime, agent: await Agent.create(runtime), trace, store, saver };
}
