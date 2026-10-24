import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { transcript, liveCalls, toolLabel } from '../src/state/transcript.ts';
import { AssistantTurn } from '../src/components/AssistantTurn.tsx';
import { createElement } from 'react';

const prompt = (id, text) => ({ id, text, role: 'user' });
const answer = (id, text, toolCalls) => ({ id, text, role: 'assistant', ...(toolCalls ? { toolCalls } : {}) });
const call = { id: 'memory', name: 'recall_memory', args: { name: 'User' }, result: { output: 'Remembered details', truncated: false } };
const route = { type: 'route', choice: 'fast', confidence: 0, probabilities: { fast: 0.5153, powerful: 0.4847 }, runId: 'second' };

test('assistant messages and tools share one turn; routing stays with its reply', () => {
  const groups = transcript([
    prompt('p1', 'uptime'), answer('a1', 'up 3 hours'),
    prompt('p2', 'what do you remember?'), answer('a2', '', [call]), answer('a3', 'Remembered details'),
  ], [route, { type: 'memory', runId: 'second', name: 'recall_memory', args: call.args, toolCallId: 'memory' }, { type: 'done', runId: 'second', text: 'Remembered details' }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].events.length, 0);
  assert.equal(groups[1].messages.length, 2);
  assert.equal(groups[1].events[0].type, 'route');
  assert.deepEqual(liveCalls(groups[1]), [], 'history already owns the memory call');
});

test('resume results and routing before approval belong to the same visual turn', () => {
  const groups = transcript([prompt('p', 'run'), answer('a1', '', [{ id: 'call', name: 'bash', args: {} }]), answer('a2', 'finished')], [
    { ...route, runId: 'send' }, { type: 'tool_call', runId: 'send', name: 'bash', args: {}, toolCallId: 'call' },
    { type: 'approval', runId: 'send', approvals: [{ id: 'approval', command: 'test' }] },
    { type: 'tool_result', runId: 'resume', toolCallId: 'call', name: 'bash', output: 'finished', truncated: false },
    { type: 'done', runId: 'resume', text: 'finished' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].events.length, 5);
});

test('live memory and skill operations use inline tool rows without duplicates', () => {
  const turn = { id: 'live', messages: [], events: [
    { type: 'memory', name: 'recall_memory', args: { name: 'User' }, toolCallId: 'memory', runId: 'run' },
    { type: 'skill', name: 'writing', toolCallId: 'skill', runId: 'run' },
  ] };
  const calls = liveCalls(turn);
  assert.deepEqual(calls.map(toolLabel), [{ name: 'Recall memory', target: 'User' }, { name: 'Load skill', target: 'writing' }]);
});

test('assistant markup aligns model, tools and reply inside one ghost bubble', () => {
  const turn = transcript([prompt('p', 'recall'), answer('call', '', [call]), answer('reply', 'Remembered details')], [route])[0];
  const html = renderToStaticMarkup(createElement(AssistantTurn, { turn, current: true, model: { activity: { phase: 'done' }, pending: [], loading: false, working: false } }));
  assert.equal((html.match(/role="img" aria-label="Wingman"/g) ?? []).length, 0);
  assert.ok(html.indexOf('fast model') < html.indexOf('Recall memory'));
  assert.ok(html.indexOf('Recall memory') < html.lastIndexOf('Remembered details'));
  assert.ok(!html.includes('Memory: recall_memory'));
  assert.ok(!html.includes('astryx-chat-system-message'));
});
