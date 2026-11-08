import { useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Banner } from "@astryxdesign/core/Banner";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import * as stylex from "@stylexjs/stylex";
import { ChevronRight, Clock, RefreshCw, Repeat2, Plus } from "lucide-react";
import { useScheduledTasks } from "../state/useScheduledTasks";
import type { ScheduledTask } from "../api/tasks";
import { taskTime, scheduleDescription } from "./schedule-format";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";

function nextRunLabel(task: ScheduledTask): string {
  if (task.state === "running") return "Running now";
  if (task.state === "paused") return "Paused";
  if (task.state === "completed" && !task.nextRunAt) return "Completed";
  if (task.state === "failed" && !task.nextRunAt) return "Failed";
  return taskTime(task.nextRunAt);
}

export function ScheduledView({
  openConversation,
  onCreateTask,
}: {
  openConversation: (id: string) => void;
  onCreateTask: () => void;
}) {
  const model = useScheduledTasks();
  const [selected, setSelected] = useState<ScheduledTask | null>(null);
  const [confirm, setConfirm] = useState<ScheduledTask | null>(null);
  const selectedTask = model.tasks.items.find((task) => task.id === selected?.id) ?? selected;
  const collection = model.tasks;
  const error = model.actionError || collection.error;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return (
    <VStack gap={6} width="100%" xstyle={styles.page}>
      <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
        <VStack gap={1}>
          <Text as="h1" weight="medium" xstyle={styles.heading}>
            Tasks
          </Text>
          <Text type="supporting">Manage reminders and recurring work.</Text>
        </VStack>
        <HStack gap={2}>
          <Button
            label="Refresh scheduled tasks"
            variant="ghost"
            isIconOnly
            icon={<Icon icon={RefreshCw} />}
            isLoading={collection.loading}
            onClick={() => void collection.refresh()}
          />
          <Button label="New task" icon={<Icon icon={Plus} />} onClick={onCreateTask} />
        </HStack>
      </HStack>
      {model.schedulerEnabled === false && (
        <Banner
          status="warning"
          title="Scheduling is disabled on this server"
          description="You can view and delete tasks. Scheduled jobs will run when scheduling is enabled."
        />
      )}
      {error && (
        <Banner
          status="error"
          role="alert"
          title="Could not complete the request"
          description={error}
          endContent={
            <HStack gap={2}>
              <Button
                label="Retry loading"
                variant="ghost"
                onClick={() => void collection.refresh()}
              />
              {model.actionError && (
                <Button label="Dismiss error" variant="ghost" onClick={model.clearFeedback} />
              )}
            </HStack>
          }
        />
      )}
      {model.notice && (
        <Banner
          status="success"
          role="status"
          title="Task deleted"
          description={model.notice}
          endContent={
            <Button label="Dismiss notification" variant="ghost" onClick={model.clearFeedback} />
          }
        />
      )}
      <VStack gap={4}>
        {model.tasks.loading && !model.tasks.items.length && (
          <Text role="status">Loading scheduled tasks…</Text>
        )}
        {!model.tasks.loading && !model.tasks.error && !model.tasks.items.length && (
          <EmptyState
            headingLevel={2}
            icon={<Icon icon={Clock} />}
            title="No scheduled tasks"
            description="Ask Wingman in a conversation to schedule a reminder or a recurring task."
          />
        )}
        <List
          hasDividers
          density="spacious"
          edge="padded"
          aria-label="Scheduled tasks"
          xstyle={styles.list}
        >
          {model.tasks.items.map((task) => (
            <ListItem
              key={task.id}
              align="center"
              startContent={
                <HStack vAlign="center" hAlign="center" xstyle={styles.taskIcon}>
                  <Icon icon={task.repeatInterval ? Repeat2 : Clock} />
                </HStack>
              }
              label={
                <Text weight="medium" maxLines={2}>
                  {task.prompt}
                </Text>
              }
              description={
                <Text type="supporting" maxLines={2}>
                  {scheduleDescription(task.repeatInterval)}
                  {task.state === "failed" && " · Last run failed"}
                </Text>
              }
              endContent={
                <HStack gap={3} vAlign="center" xstyle={styles.rowEnd}>
                  <Text type="supporting" xstyle={styles.nextRun}>
                    {nextRunLabel(task)}
                  </Text>
                  <Icon icon={ChevronRight} size="sm" />
                </HStack>
              }
              onClick={() => {
                model.clearFeedback();
                setSelected(task);
              }}
            />
          ))}
        </List>
        <Text type="supporting">Next run times are shown in {timezone}.</Text>
        {collection.nextCursor && (
          <Button
            label="Load more tasks"
            variant="ghost"
            isLoading={collection.loading}
            onClick={() => void collection.more()}
          />
        )}
      </VStack>
      {selectedTask && (
        <ScheduledTaskDialog
          task={selectedTask}
          busy={Boolean(model.cancelling)}
          onClose={() => setSelected(null)}
          onDelete={() => {
            setConfirm(selectedTask);
            setSelected(null);
          }}
          openConversation={openConversation}
        />
      )}
      {confirm && (
        <Dialog
          isOpen
          purpose="form"
          padding={6}
          onOpenChange={(open) => {
            if (!open && !model.cancelling) setConfirm(null);
          }}
        >
          <DialogHeader title="Delete this task?" subtitle="Wingman will stop running this task." />
          <VStack gap={4}>
            <Text as="p" maxLines={4}>
              {confirm.prompt}
            </Text>
            {model.actionError && <Text role="alert">{model.actionError}</Text>}
            <HStack gap={2} hAlign="end" wrap="wrap">
              <Button
                label="Keep task"
                isDisabled={Boolean(model.cancelling)}
                onClick={() => setConfirm(null)}
              />
              <Button
                label="Delete task"
                variant="destructive"
                isLoading={Boolean(model.cancelling)}
                onClick={() => {
                  void model.cancel(confirm).then((success) => {
                    if (success) setConfirm(null);
                  });
                }}
              />
            </HStack>
          </VStack>
        </Dialog>
      )}
    </VStack>
  );
}

const styles = stylex.create({
  page: {
    maxWidth: "calc(var(--spacing-8) * 31)",
    marginInline: "auto",
    paddingBlock: "var(--spacing-8)",
    paddingInline: { default: "var(--spacing-8)", "@media (max-width: 640px)": "var(--spacing-4)" },
  },
  heading: { fontSize: "calc(var(--text-large-size) * 1.5)", lineHeight: 1.3 },
  list: {
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-container)",
    overflow: "hidden",
  },
  taskIcon: {
    width: "var(--spacing-10)",
    height: "var(--spacing-10)",
    borderRadius: "var(--radius-container)",
    backgroundColor: "var(--color-background-muted)",
    flexShrink: 0,
  },
  rowEnd: { flexShrink: 0 },
  nextRun: {
    width: {
      default: "calc(var(--spacing-8) * 5)",
      "@media (max-width: 640px)": "calc(var(--spacing-8) * 3)",
    },
    textAlign: "right",
    flexShrink: 0,
  },
});
