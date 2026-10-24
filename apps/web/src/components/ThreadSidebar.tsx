import { SideNav, SideNavSection, SideNavItem } from '@astryxdesign/core/SideNav';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { MessageSquare, Trash2, RotateCcw, SquarePen, Clock } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import wingmanLogo from '../../../../assets/branding/wingman-logo.png';
import type { Wingman } from '../state/useWingman';
import type { Thread } from '../api/types';

export function ThreadSidebar({ model, onDelete }: {
  model: Wingman; onDelete: (thread: Thread) => void;
}) {
  return (
    <SideNav resizable header={<HStack gap={2} vAlign="center">
      <img src={wingmanLogo} alt="" {...stylex.props(styles.logo)} />
      <VStack gap={1}>
        <h2 {...stylex.props(styles.title)}>Wingman</h2>
        <p {...stylex.props(styles.tagline)}>Always watching your six</p>
      </VStack>
    </HStack>}
      footer={<VStack gap={2}>
      </VStack>}>
      <SideNavItem key='new-conversation' label='New conversation' icon={SquarePen} isDisabled={model.working} onClick={() => void model.create()} />
      <SideNavItem key='new-conversation' label='Scheduled' icon={Clock} isDisabled={model.working} onClick={() => void model.create()} />
      <SideNavSection title="Conversations" endContent={
        <IconButton
          label='Refresh'
          variant="ghost" onClick={() => void model.refreshThreads()}
          icon={<Icon icon={RotateCcw} size='xsm' />}
        />
      }>
        {model.threads.map(thread => (
          <SideNavItem key={thread.id} label={thread.title} icon={MessageSquare} isSelected={thread.id === model.threadId}
            onClick={() => model.select(thread.id)} actions={
              <Button label={`Delete ${thread.title}`} icon={<Icon icon={Trash2} />} isIconOnly variant="ghost" isDisabled={model.working} onClick={() => onDelete(thread)} />
            } />
        ))}
        {!model.threads.length && <Text type="supporting">Your conversations will appear here.</Text>}
      </SideNavSection>
      {model.catalogueCursor && <Button label="Load more conversations" variant="ghost" onClick={() => void model.refreshThreads(true)} />}
    </SideNav>
  );
}

const styles = stylex.create({
  logo: { width: 'var(--spacing-8)', height: 'var(--spacing-8)', objectFit: 'contain', flexShrink: 0 },
  title: {
    fontFamily: '"Press Start 2P", monospace', fontSize: 'var(--text-supporting-size)',
    fontWeight: 400, lineHeight: 'var(--text-large-leading)',
  },
  tagline: {
    fontFamily: '"Press Start 2P", monospace', fontSize: 'calc(var(--text-supporting-size) * 0.55)',
    fontWeight: 400, lineHeight: 1.6, whiteSpace: 'normal', color: 'var(--color-text-secondary)',
  },
});
