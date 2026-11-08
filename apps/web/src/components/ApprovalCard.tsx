import { delegatedPlans } from "../state/delegation";
import type { ThreadEvent } from "../api/types";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Text } from "@astryxdesign/core/Text";
import type { Approval } from "../api/types";

export function ApprovalCard({
  approvals,
  busy,
  submit,
  events = [],
}: {
  events?: ThreadEvent[];
  approvals: Approval[];
  busy: boolean;
  submit: (answers: Record<string, boolean>) => Promise<void>;
}) {
  const tasks = delegatedPlans(events).flatMap((plan) => plan.tasks);
  const owner = (approval: Approval) => {
    const task = tasks.find((task) => task.taskId === approval.execution.taskId);
    return task ? `${task.key} · ${task.agentId}` : approval.execution.agentId;
  };
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const choose = (id: string, approved: boolean) => {
    if (approvals.length === 1) void submit({ [id]: approved });
    else setAnswers((old) => ({ ...old, [id]: approved }));
  };
  return (
    <Banner
      status="warning"
      title="Your approval is needed"
      description="Review the commands before they run on the server."
      collapsible={false}
    >
      <VStack gap={4}>
        {approvals.map((approval, index) => (
          <VStack key={approval.id} gap={2}>
            <CodeBlock
              language="bash"
              title={`${owner(approval)} · Command ${index + 1}`}
              code={approval.command}
            />
            <HStack gap={2} wrap="wrap">
              <Button
                label="Approve"
                variant={answers[approval.id] === true ? "primary" : "secondary"}
                isDisabled={busy}
                onClick={() => choose(approval.id, true)}
              />
              <Button
                label="Deny"
                variant="secondary"
                isDisabled={busy}
                onClick={() => choose(approval.id, false)}
              />
              {approval.id in answers && (
                <Text type="supporting">{answers[approval.id] ? "Will approve" : "Will deny"}</Text>
              )}
            </HStack>
          </VStack>
        ))}
        {approvals.length > 1 && (
          <Button
            label="Submit decisions"
            variant="primary"
            isDisabled={busy || approvals.some((a) => !(a.id in answers))}
            onClick={() =>
              void submit(Object.fromEntries(approvals.map((a) => [a.id, answers[a.id]])))
            }
          />
        )}
      </VStack>
    </Banner>
  );
}
