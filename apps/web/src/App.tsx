// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from Astryx's ai-chat page template: Layout > chat column > ChatLayout.
import { useEffect, useState } from 'react';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Layout, LayoutContent, LayoutHeader, HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import * as stylex from '@stylexjs/stylex';
import { ThreadSidebar } from './components/ThreadSidebar';
import { Conversation } from './components/Conversation';
import { useWingman } from './state/useWingman';
import { removeLegacyConnection } from './state/storage';
import { defaultConnection } from './api/client';
import type { Thread } from './api/types';

export default function App() {
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const model = useWingman(defaultConnection);
  useEffect(removeLegacyConnection, []);
  const title = model.threads.find(t => t.id === model.threadId)?.title ?? 'New conversation';
  const status = model.threadId && model.stream !== 'live'
    ? ({ connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Connection unavailable' })[model.stream]
    : null;
  return (
    <>
      <AppShell height="fill" variant="section" contentPadding={0}
        sideNav={<ThreadSidebar model={model} onDelete={setDeleting} />}>
        <Layout height="fill" header={<LayoutHeader hasDivider padding={3}>
          <HStack gap={3} vAlign="center">
            <Text as="h1" weight="medium" maxLines={1} xstyle={styles.title}>{model.threadId ? title : 'New conversation'}</Text>
            {status && <Text type="supporting" role="status" xstyle={styles.status}>{status}</Text>}
          </HStack>
        </LayoutHeader>} content={
          <LayoutContent padding={0} isScrollable={false}>
            <VStack height="100%" width="100%">
              {model.error && <Banner role="alert" status="error" container="section" title="Request could not be completed" description={model.error}
                endContent={<Button label="Dismiss" variant="ghost" onClick={() => { model.clearError(); }} />} />}
              <Conversation model={model} />
            </VStack>
          </LayoutContent>
        } />
      </AppShell>
      {deleting && <Dialog isOpen onOpenChange={open => { if (!open) setDeleting(null); }} purpose="form" padding={6}>
        <DialogHeader title="Delete conversation?" subtitle={deleting.title} />
        <VStack gap={5}>
          {model.error && <Banner role="alert" status="error" title="Could not delete conversation" description={model.error} />}
          <Text as="p">This removes the conversation, saved messages and event history. Scheduled tasks and shared memory remain.</Text>
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button label="Cancel" onClick={() => setDeleting(null)} isDisabled={model.working} />
            <Button label="Delete conversation" variant="destructive" isLoading={model.working} onClick={() => { void model.remove(deleting.id).then(success => { if (success) setDeleting(null); }); }} />
          </HStack>
        </VStack>
      </Dialog>}
    </>
  );
}

const styles = stylex.create({
  title: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  status: { flexShrink: 0 },
});
