import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { interrupt, MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';

// Deterministic model: actual LangChain tool loop, without a network endpoint.
class ApprovalModel extends BaseChatModel {
  _llmType() { return 'approval-test'; }
  bindTools() { return this; }
  async _generate(messages) {
    const humanIndex = messages.findLastIndex(HumanMessage.isInstance);
    const request = messages[humanIndex].text;
    const results = messages.slice(humanIndex + 1).filter(ToolMessage.isInstance);
    let calls = [];
    if (request.startsWith('run') && results.length === 0) {
      calls = [{ name: 'test_action', args: { command: 'test-1' }, id: 'call-1', type: 'tool_call' }];
      if (request === 'run two') calls.push({ name: 'test_action', args: { command: 'test-2' }, id: 'call-2', type: 'tool_call' });
    } else if (request === 'run twice' && results.length === 1) {
      calls = [{ name: 'test_action', args: { command: 'test-2' }, id: 'call-2', type: 'tool_call' }];
    }
    const message = new AIMessage({ content: calls.length ? '' : results.length ? results.map(m => m.text).join(', ') : request, tool_calls: calls });
    return { generations: [{ text: message.text, message }] };
  }
}

/** A real agent/checkpointer with a harmless, observable tool side effect. */
export function createApprovalAgent({ checkpointer = new MemorySaver() } = {}) {
  const executions = [];
  const action = tool(async ({ command }) => {
    const approved = interrupt({ kind: 'bash_approval', command });
    if (approved !== true) return 'declined';
    executions.push(command);
    return `executed ${command}`;
  }, { name: 'test_action', description: 'Test action requiring approval', schema: z.object({ command: z.string() }) });
  return { agent: { app: createAgent({ model: new ApprovalModel({}), tools: [action], checkpointer }) }, executions };
}
