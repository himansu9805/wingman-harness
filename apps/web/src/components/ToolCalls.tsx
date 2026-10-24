import * as stylex from '@stylexjs/stylex';
import { ChatToolCalls } from '@astryxdesign/core/Chat';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { toolLabel } from '../state/transcript';
import type { ToolCall } from '../api/types';

export function ToolCalls({ calls, running }: { calls: ToolCall[]; running: boolean }) {
  return <ChatToolCalls xstyle={styles.calls} calls={calls.map(call => ({
    key: call.id, ...toolLabel(call),
    status: call.result ? 'complete' as const : running ? 'running' as const : 'pending' as const,
    resultDetail: call.result ? <VStack gap={2}>
      <CodeBlock code={call.result.output} language="text" title={`${call.name} output`} />
      {call.result.truncated && <Text type="supporting">Output preview truncated.</Text>}
    </VStack> : undefined,
  }))} />;
}

const styles = stylex.create({ calls: { margin: 0 } });
