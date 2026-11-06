import { useEffect, useId, useRef } from 'react';
import { Dialog } from '@astryxdesign/core/Dialog';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { MessageSquare, Trash2, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { ScheduledTask } from '../api/tasks';
import { scheduleDescription, taskTime } from './schedule-format';

export function ScheduledTaskDialog({ task, busy, onClose, onDelete, openConversation }: {
  task: ScheduledTask;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
  openConversation: (id: string) => void;
}) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const running = task.state === 'running';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return <Dialog isOpen aria-labelledby={titleId} purpose="info" width="calc(var(--spacing-8) * 16)" padding={6}
    onOpenChange={open => { if (!open) onClose(); }}>
    <VStack gap={5}>
      <HStack gap={3} hAlign="between" vAlign="center">
        <Text as="h2" id={titleId} ref={titleRef} tabIndex={-1} weight="medium" xstyle={styles.title}>Scheduled task</Text>
        <Button label="Close task details" variant="ghost" isIconOnly icon={<Icon icon={X} />} onClick={onClose} />
      </HStack>
      <VStack gap={4}>
        <VStack gap={2}>
          <Text type="supporting">Instructions</Text>
          <Text as="p" xstyle={styles.instructions}>{task.prompt}</Text>
        </VStack>
        <VStack gap={0}>
          <HStack gap={5} hAlign="between" vAlign="start" xstyle={styles.field}>
            <Text type="supporting" xstyle={styles.label}>Schedule</Text>
            <VStack gap={1} xstyle={styles.value}>
              <Text>{scheduleDescription(task.repeatInterval)}</Text>
              {task.repeatInterval && <Text type="supporting">Server time</Text>}
            </VStack>
          </HStack>
          <HStack gap={5} hAlign="between" vAlign="start" xstyle={styles.field}>
            <Text type="supporting" xstyle={styles.label}>Next run</Text>
            <VStack gap={1} xstyle={styles.value}>
              <Text>{running ? 'Running now' : taskTime(task.nextRunAt)}</Text>
              {task.nextRunAt && <Text type="supporting">{timezone}</Text>}
            </VStack>
          </HStack>
          <HStack gap={5} hAlign="between" vAlign="start" xstyle={styles.field}>
            <Text type="supporting" xstyle={styles.label}>Status</Text>
            <Text xstyle={styles.status}>{task.state}</Text>
          </HStack>
        </VStack>
        <HStack gap={3} hAlign="between" vAlign="center" xstyle={styles.footer}>
          <Button label="Delete task" variant="ghost" icon={<Icon icon={Trash2} />}
            tooltip={running ? 'Available after the current run finishes' : 'Delete task'}
            isDisabled={running || busy} onClick={onDelete} />
          <HStack gap={2}>
            {task.threadId && <Button label="Open chat" variant="primary" icon={<Icon icon={MessageSquare} />}
              onClick={() => openConversation(task.threadId!)} />}
            {!task.threadId && <Button label="Done" variant="primary" onClick={onClose} />}
          </HStack>
        </HStack>
      </VStack>
    </VStack>
  </Dialog>;
}

const styles = stylex.create({
  title: { fontSize: 'var(--text-large-size)' },
  instructions: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 'var(--text-body-leading)' },
  field: { paddingBlock: 'var(--spacing-2)', borderBottom: '1px solid var(--color-border)' },
  label: { flexShrink: 0 },
  value: { textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' },
  status: { textTransform: 'capitalize' },
  footer: { borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-4)' },
});
