import { Fragment, useEffect, useRef, useState } from "react";
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
} from "@astryxdesign/core/Chat";
import * as stylex from "@stylexjs/stylex";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Button } from "@astryxdesign/core/Button";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { SearchIcon, Pen, Calendar } from "lucide-react";
import { AssistantTurn } from "./AssistantTurn";
import { transcript } from "../model/transcript";
import type { Wingman } from "../model/useWingman";

const recommendedPrompts = [
  {
    icon: SearchIcon,
    label: "Research and analyze a topic",
    prompt: "Analyze and provide report on impact of AI on job market.",
  },
  {
    icon: Pen,
    label: "Generate a creative story",
    prompt: "Write a short story about a robot who discovers emotions.",
  },
  {
    icon: Calendar,
    label: "Schedule a task",
    prompt: "Schedule a meeting with the team for next Monday at 10 AM.",
  },
];

/** Render saved and live turns with a composer that preserves the current draft. */
export function Conversation({ model }: { model: Wingman }) {
  const [draft, setDraft] = useState("");
  const previousThread = useRef(model.threadId);
  useEffect(() => {
    // Keep the composer mounted during first-send creation so a failed send
    // can restore its draft. Ordinary conversation switches clear the input.
    if (previousThread.current !== model.threadId && previousThread.current !== null) setDraft("");
    previousThread.current = model.threadId;
  }, [model.threadId]);
  const running = model.activity.phase === "running";
  const turns = transcript(model.history.messages, model.activity.events);
  const submit = async (value: string) => {
    if (!value.trim() || value.trim().length > 20_000) return;
    setDraft("");
    if (!(await model.send(value.trim()))) setDraft((current) => current || value);
  };
  return (
    <StackItem as={VStack} size="fill">
      <ChatLayout
        density="spacious"
        composer={
          <ChatComposer
            input={<ChatComposerInput label="Message input" pasteAsToken={false} />}
            value={draft}
            onChange={setDraft}
            onSubmit={(value) => void submit(value)}
            placeholder={
              model.pending.length ? "Answer the approval above to continue…" : "Message Wingman…"
            }
            isDisabled={
              running ||
              model.loading ||
              model.working ||
              model.pending.length > 0 ||
              (Boolean(model.threadId) && model.stream !== "live")
            }
            status={
              draft.length > 20_000
                ? { type: "error", message: "Messages must be 20,000 characters or fewer." }
                : undefined
            }
            footerActions={
              <Text type="supporting">
                {running
                  ? "Wingman is working. Wait for this task to finish before sending another message."
                  : "Commands requiring approval wait for your decision."}
              </Text>
            }
          />
        }
      >
        <ChatMessageList align="top" isStreaming={running}>
          {model.history.nextCursor && (
            <Button
              label="Load older messages"
              variant="ghost"
              isLoading={model.working}
              onClick={() => void model.older()}
            />
          )}
          {model.loading && <ChatSystemMessage>Loading conversation…</ChatSystemMessage>}
          {!model.loading && !model.history.messages.length && !running && (
            <VStack gap={4} hAlign="center" vAlign="center" xstyle={styles.emptyState}>
              <EmptyState
                headingLevel={2}
                title="What are we working on?"
                description="Ask a question, run a task, or set a reminder. Wingman will ask before running commands that need approval."
              />
              <HStack gap={2} vAlign="stretch" xstyle={styles.promptGrid}>
                {recommendedPrompts.map((item) => (
                  <ClickableCard
                    key={item.label}
                    label={item.label}
                    elevation="med"
                    width="100%"
                    height="100%"
                    onClick={() => {
                      setDraft(item.prompt);
                    }}
                  >
                    <VStack gap={1} hAlign="stretch">
                      <HStack gap={2} vAlign="center" hAlign="start">
                        <Icon icon={item.icon} size="sm" />
                        <Heading level={4}>{item.label}</Heading>
                      </HStack>
                      <Text type="body" color="secondary">
                        {item.prompt}
                      </Text>
                    </VStack>
                  </ClickableCard>
                ))}
              </HStack>
            </VStack>
          )}
          {turns.map((turn, index) => (
            <Fragment key={turn.id}>
              {turn.user && (
                <ChatMessage sender="user">
                  <ChatMessageBubble>
                    <Text as="p">
                      {turn.user.text.split("\n").map((line, i) => (
                        <Fragment key={i}>
                          {i > 0 && <br />}
                          {line}
                        </Fragment>
                      ))}
                    </Text>
                  </ChatMessageBubble>
                </ChatMessage>
              )}
              <AssistantTurn turn={turn} model={model} current={index === turns.length - 1} />
            </Fragment>
          ))}
        </ChatMessageList>
      </ChatLayout>
    </StackItem>
  );
}

const styles = stylex.create({
  emptyState: {
    flex: 1,
    minHeight: "min-content",
    padding: "var(--spacing-6)",
  },
  promptGrid: {
    display: "grid",
    width: "100%",
    maxWidth: "48rem",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      "@media (max-width: 600px)": "minmax(0, 1fr)",
    },
    gridAutoRows: "1fr",
  },
  route: {
    backgroundColor: "var(--color-surface-2)",
    borderRadius: "var(--border-radius-2)",
    padding: "var(--spacing-2) var(--spacing-3)",
  },
});
