import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Icon } from "@astryxdesign/core/Icon";
import { CheckCircle2, Circle, Clock, GitBranch, OctagonAlert, Play, XCircle } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ThreadEvent } from "../api/types";
import type { DelegationTask, DelegationPlanSnapshot } from "../api/delegation";
import { delegatedPlans, taskCalls, taskStatus, tokenLabel } from "../state/delegation";
import { duration } from "../state/run-summary";
import { ToolCalls } from "./ToolCalls";

export function DelegatedWork({ events }: { events: ThreadEvent[] }) {
  return delegatedPlans(events).map((plan) => (
    <Plan key={plan.planId} plan={plan} events={events} />
  ));
}
function Plan({ plan, events }: { plan: DelegationPlanSnapshot; events: ThreadEvent[] }) {
  const complete = plan.tasks.filter((task) => task.status === "completed").length;
  return (
    <VStack gap={2} xstyle={styles.plan}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Icon icon={GitBranch} size="sm" />
        <Text type="supporting" weight="medium">
          Delegated work
        </Text>
        <Text type="supporting">
          {complete} of {plan.tasks.length} completed ·{" "}
          {plan.error ? "Needs review" : taskStatus(plan.status)}
        </Text>
      </HStack>
      <VStack gap={2} hAlign="stretch">
        {plan.tasks.map((task) => (
          <Task key={task.key} task={task} events={events} />
        ))}
        <Text type="supporting">
          {duration(plan.elapsedMs)} elapsed at last update · Task tokens are included in the turn
          total. Parallel task durations overlap.
        </Text>
      </VStack>
      {plan.error && (
        <Text type="supporting" role="status">
          {plan.error}
        </Text>
      )}
    </VStack>
  );
}
function Task({ task, events }: { task: DelegationTask; events: ThreadEvent[] }) {
  const calls = taskCalls(task.taskId, events).map((call) => ({
    ...call,
    decision: task.decisions.find((item) => item.toolCallId === call.id)?.approved,
  }));
  const icon =
    task.status === "completed"
      ? CheckCircle2
      : task.status === "waiting_approval"
        ? Clock
        : task.status === "running"
          ? Play
          : task.status === "recovery_required"
            ? OctagonAlert
            : ["failed", "interrupted", "cancelled", "blocked"].includes(task.status)
              ? XCircle
              : Circle;
  return (
    <VStack gap={1}>
      <Collapsible
        defaultIsOpen={false}
        chevronPosition="start"
        trigger={
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon icon={icon} size="sm" />
            <Text type="supporting" weight="medium">
              {task.key}
            </Text>
            <Text type="supporting">
              {task.agentId} · {taskStatus(task.status)}
            </Text>
          </HStack>
        }
      >
        <VStack gap={3} xstyle={styles.details}>
          <Text>{task.objective}</Text>
          {task.dependsOn.length > 0 && (
            <Text type="supporting">Depends on: {task.dependsOn.join(", ")}</Text>
          )}
          <Text type="supporting">
            {duration(task.processingMs)} processing · {tokenLabel(task.usage)} ·{" "}
            {task.usage.modelCalls} model calls
          </Text>
          {task.approvalWaitMs > 0 && task.status !== "waiting_approval" && (
            <Text type="supporting">{duration(task.approvalWaitMs)} waiting for approval</Text>
          )}
          {calls.length > 0 && (
            <ToolCalls calls={calls} running={task.status === "running"} grouped={false} />
          )}
          {calls.length < task.toolCount && (
            <Text type="supporting">
              Showing recent tool activity ({calls.length} of {task.toolCount} calls).
            </Text>
          )}
          {task.output && <Markdown density="compact">{task.output}</Markdown>}
          {task.truncated && <Text type="supporting">Task result preview truncated.</Text>}
        </VStack>
      </Collapsible>
      {task.status === "waiting_approval" && (
        <Text type="supporting" xstyle={styles.notice}>
          Review this task’s commands below to continue.
        </Text>
      )}
      {task.error && (
        <Text type="supporting" xstyle={styles.notice}>
          {task.error}
        </Text>
      )}
    </VStack>
  );
}
const styles = stylex.create({
  plan: { marginTop: "var(--spacing-3)", marginBottom: "var(--spacing-3)" },
  details: { paddingInlineStart: "var(--spacing-5)", paddingBlockEnd: "var(--spacing-2)" },
  notice: { paddingInlineStart: "var(--spacing-5)" },
});
