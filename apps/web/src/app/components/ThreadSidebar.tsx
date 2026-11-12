import { useState } from "react";
import { SideNav, SideNavSection, SideNavItem } from "@astryxdesign/core/SideNav";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { Spinner } from "@astryxdesign/core/Spinner";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MessageSquare, Trash2, RotateCcw, SquarePen, Clock } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import wingmanLogo from "../../../../../assets/branding/wingman-logo.png";
import type { Wingman } from "../../features/chat/model/useWingman";
import type { Thread } from "../../shared/contracts/types";

/** Render conversation navigation, scheduled-task indicators, and conversation actions. */
export function ThreadSidebar({
  model,
  onDelete,
  scheduled,
  onScheduled,
  onNew,
  onSelect,
}: {
  model: Wingman;
  onDelete: (thread: Thread) => void;
  scheduled: boolean;
  onScheduled: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <SideNav
      resizable
      header={
        <HStack gap={2} vAlign="center">
          <img src={wingmanLogo} alt="" {...stylex.props(styles.logo)} />
          <VStack gap={1}>
            <h2 {...stylex.props(styles.title)}>Wingman</h2>
            <p {...stylex.props(styles.tagline)}>Always watching your six</p>
          </VStack>
        </HStack>
      }
      footer={<VStack gap={2}></VStack>}
    >
      <SideNavItem
        key="new-conversation"
        label="New conversation"
        icon={SquarePen}
        isDisabled={model.working}
        onClick={onNew}
      />
      <SideNavItem
        key="scheduled"
        label="Scheduled"
        icon={Clock}
        isSelected={scheduled}
        onClick={onScheduled}
      />
      <SideNavSection
        title="Conversations"
        endContent={
          <IconButton
            label="Refresh"
            variant="ghost"
            onClick={() => void model.refreshThreads()}
            icon={<Icon icon={RotateCcw} size="xsm" />}
          />
        }
      >
        {model.threads.map((thread) => (
          <ConversationItem
            key={thread.id}
            thread={thread}
            model={model}
            scheduled={scheduled}
            onDelete={onDelete}
            onSelect={onSelect}
          />
        ))}
        {!model.threads.length && (
          <Text type="supporting">Your conversations will appear here.</Text>
        )}
      </SideNavSection>
      {model.catalogueCursor && (
        <Button
          label="Load more conversations"
          variant="ghost"
          onClick={() => void model.refreshThreads(true)}
        />
      )}
    </SideNav>
  );
}

/** Show conversation actions while the row is hovered or contains keyboard focus. */
function ConversationItem({
  thread,
  model,
  scheduled,
  onDelete,
  onSelect,
}: {
  thread: Thread;
  model: Wingman;
  scheduled: boolean;
  onDelete: (thread: Thread) => void;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isSelected = thread.id === model.threadId;
  const isRunning =
    isSelected && model.activity.phase !== "idle"
      ? model.activity.phase === "running"
      : thread.runStatus === "running";

  return (
    <section
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <SideNavItem
        label={thread.hasScheduledTasks ? `${thread.title} · Scheduled` : thread.title}
        icon={thread.hasScheduledTasks ? Clock : MessageSquare}
        isSelected={!scheduled && isSelected}
        endContent={
          isRunning ? <Spinner size="sm" aria-label={`Processing ${thread.title}`} /> : undefined
        }
        onClick={() => onSelect(thread.id)}
        actions={
          !isRunning && (hovered || focused) ? (
            <Button
              label={`Delete ${thread.title}`}
              icon={<Icon icon={Trash2} />}
              isIconOnly
              variant="ghost"
              isDisabled={model.working}
              onClick={() => onDelete(thread)}
            />
          ) : undefined
        }
      />
    </section>
  );
}

const styles = stylex.create({
  logo: {
    width: "var(--spacing-8)",
    height: "var(--spacing-8)",
    objectFit: "contain",
    flexShrink: 0,
  },
  title: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "var(--text-supporting-size)",
    fontWeight: 400,
    lineHeight: "var(--text-large-leading)",
  },
  tagline: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "calc(var(--text-supporting-size) * 0.55)",
    fontWeight: 400,
    lineHeight: 1.6,
    whiteSpace: "normal",
    color: "var(--color-text-secondary)",
  },
});
