import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Icon } from '@astryxdesign/core/Icon';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Cpu, Clock } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { RunSummary } from './RunSummary';
import { latestRun } from '../state/run-summary';
import { ToolCalls } from './ToolCalls';
import { ApprovalCard } from './ApprovalCard';
import { liveCalls, type TranscriptTurn } from '../state/transcript';
import { toolsWithResults } from '../state/events';
import type { Wingman } from '../state/useWingman';
import { Tooltip } from '@astryxdesign/core';

export function AssistantTurn({ turn, model, current }: { turn: TranscriptTurn; model: Wingman; current: boolean }) {
  const running = current && model.activity.phase === 'running';
  const route = turn.events.findLast(event => event.type === 'route');
  const scheduled = turn.events.find(event => event.type === 'scheduled');
  const calls = liveCalls(turn);
  const metadata = latestRun(turn);
  const approvals = current ? model.pending : [];
  if (!turn.messages.length && !turn.events.length && !approvals.length && !running) return null;
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost" width="100%">
        <VStack gap={0} hAlign="stretch">
          {scheduled?.type === 'scheduled' && <HStack gap={2} vAlign="center">
            <Icon icon={Clock} size="sm" /><Text type="supporting">Scheduled task · {scheduled.prompt}</Text>
          </HStack>}
          {route?.type === 'route' && <HStack xstyle={styles.route} gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting" weight="medium">Routed to{' '}
              <Tooltip placement="above" content=
                {route.probabilities && <Text type="supporting">{Object.entries(route.probabilities).map(([name, score]) => `${name}: ${(score * 100).toFixed(2)}%`).join(' · ')}</Text>}
              >
                {`${route.choice} model`}
              </Tooltip></Text>
          </HStack>}
          {turn.messages.map(message => <VStack key={message.id} gap={3}>
            {message.toolCalls?.length ? <ToolCalls calls={toolsWithResults(message.toolCalls, turn.events)} running={running} /> : null}
            {message.text && <Markdown density="compact" xstyle={styles.answer}>{message.text}</Markdown>}
          </VStack>)}
          {calls.length > 0 && <ToolCalls calls={toolsWithResults(calls, turn.events)} running={running} />}
          {approvals.length > 0 && <ApprovalCard key={approvals.map(a => a.id).join(',')} approvals={approvals} busy={model.working || model.loading} submit={model.resume} />}
          {metadata && <RunSummary run={metadata} />}
          {running && <Text type="supporting" role="status">Working…</Text>}
        </VStack>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

const styles = stylex.create({
  route: { marginBottom: 'var(--spacing-1)' },
  answer: { marginTop: 'var(--spacing-4)' },
});
