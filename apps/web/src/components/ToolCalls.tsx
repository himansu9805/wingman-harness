import * as stylex from '@stylexjs/stylex';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { ChatToolCalls } from '@astryxdesign/core/Chat';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { toolLabel } from '../state/transcript';
import type { ToolCall } from '../api/types';
import { Hammer, ToolCase } from 'lucide-react';
import { Icon } from '@astryxdesign/core';

export function ToolCalls({ calls, running }: { calls: ToolCall[]; running: boolean }) {
  const items = calls.map(call => ({
    key: call.id, ...toolLabel(call),
    status: call.result ? 'complete' as const : running ? 'running' as const : 'pending' as const,
    resultDetail: call.result ? <VStack gap={2}>
      <CodeBlock code={call.result.output} language="text" title={`${call.name} output`} />
      {call.result.truncated && <Text type="supporting">Output preview truncated.</Text>}
    </VStack> : undefined,
  }));
  if (items.length <= 1) return <ChatToolCalls xstyle={styles.calls} calls={items} />;
  const complete = calls.filter(call => call.result !== undefined).length;
  const label = complete === calls.length ? `${calls.length} tool calls completed`
    : complete > 0 ? `${complete} of ${calls.length} tool calls completed`
      : `${calls.length} tool calls ${running ? 'running' : 'pending'}`;
  return <Collapsible style={styles.calls} defaultIsOpen={false} trigger={
    <HStack gap={2}><Icon icon={Hammer} size='sm' />
      <Text type="supporting" weight="medium">{label}</Text></HStack>}>
    <VStack gap={0}>
      {items.map(item => <ChatToolCalls key={item.key} xstyle={styles.calls} calls={[item]} />)}
    </VStack>
  </Collapsible>;
}

const styles = stylex.create({ calls: { margin: 0 } });
