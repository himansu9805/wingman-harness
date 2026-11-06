import { Fragment, useEffect, useRef, useState } from 'react';
import { ChatComposer, ChatComposerInput, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage } from '@astryxdesign/core/Chat';
import { StackItem, VStack } from '@astryxdesign/core/Layout';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { AssistantTurn } from './AssistantTurn';
import { transcript } from '../state/transcript';
import type { Wingman } from '../state/useWingman';

export function Conversation({ model }: { model: Wingman }) {
  const [draft, setDraft] = useState('');
  const previousThread = useRef(model.threadId);
  useEffect(() => {
    // Keep the composer mounted during first-send creation so a failed send
    // can restore its draft. Ordinary conversation switches clear the input.
    if (previousThread.current !== model.threadId && previousThread.current !== null) setDraft('');
    previousThread.current = model.threadId;
  }, [model.threadId]);
  const running = model.activity.phase === 'running';
  const turns = transcript(model.history.messages, model.activity.events);
  const submit = async (value: string) => {
    if (!value.trim() || value.trim().length > 20_000) return;
    setDraft('');
    if (!await model.send(value.trim())) setDraft(current => current || value);
  };
  return (
    <StackItem as={VStack} size="fill">
      <ChatLayout density="spacious" composer={
        <ChatComposer input={<ChatComposerInput label="Message input" pasteAsToken={false} />} value={draft} onChange={setDraft} onSubmit={value => void submit(value)}
          placeholder={model.pending.length ? 'Answer the approval above to continue…' : 'Message Wingman…'}
          isDisabled={running || model.loading || model.working || model.pending.length > 0 || (Boolean(model.threadId) && model.stream !== 'live')}
          status={draft.length > 20_000 ? { type: 'error', message: 'Messages must be 20,000 characters or fewer.' } : undefined}
          footerActions={<Text type="supporting">{running ? 'Wingman is working. Wait for this task to finish before sending another message.' : 'Commands requiring approval wait for your decision.'}</Text>} />
      }>
        <ChatMessageList align="top" isStreaming={running}>
          {model.history.nextCursor && <Button label="Load older messages" variant="ghost" isLoading={model.working} onClick={() => void model.older()} />}
          {model.loading && <ChatSystemMessage>Loading conversation…</ChatSystemMessage>}
          {!model.loading && !model.history.messages.length && !running && <EmptyState headingLevel={2} title="What are we working on?" description="Ask a question, run a task, or set a reminder. Wingman will ask before running commands that need approval." />}
          {turns.map((turn, index) => <Fragment key={turn.id}>
            {turn.user && <ChatMessage sender="user"><ChatMessageBubble>
              <Text as="p">{turn.user.text.split('\n').map((line, i) => <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>)}</Text>
            </ChatMessageBubble></ChatMessage>}
            <AssistantTurn turn={turn} model={model} current={index === turns.length - 1} />
          </Fragment>)}
        </ChatMessageList>
      </ChatLayout>
    </StackItem>
  );
}
