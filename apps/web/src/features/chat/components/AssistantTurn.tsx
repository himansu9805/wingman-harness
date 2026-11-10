import { turnContent } from "../model/turn-content";
import { DelegatedWork } from "./DelegatedWork";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Cpu, Clock } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { RunSummary } from "./RunSummary";
import { latestRun } from "../model/run-summary";
import { ToolCalls } from "./ToolCalls";
import { ApprovalCard } from "./ApprovalCard";
import { type TranscriptTurn } from "../model/transcript";
import { toolsWithResults } from "../model/events";
import type { Wingman } from "../model/useWingman";
import { Tooltip } from "@astryxdesign/core";

/** Render a turn’s ordered tool activity, delegation, response, approvals, and run metadata. */
export function AssistantTurn({
  turn,
  model,
  current,
}: {
  turn: TranscriptTurn;
  model: Wingman;
  current: boolean;
}) {
  const running = current && model.activity.phase === "running";
  const route = turn.events.findLast((event) => event.type === "route");
  const scheduled = turn.events.find((event) => event.type === "scheduled");
  const content = turnContent(turn);
  const metadata = latestRun(turn);
  const approvals = current ? model.pending : [];
  if (!turn.messages.length && !turn.events.length && !approvals.length && !running) return null;
  return (
    <ChatMessage sender="assistant">
      <ChatMessageBubble variant="ghost" width="100%">
        <VStack gap={0} hAlign="stretch">
          {scheduled?.type === "scheduled" && (
            <HStack gap={2} vAlign="center">
              <Icon icon={Clock} size="sm" />
              <Text type="supporting">Scheduled task · {scheduled.prompt}</Text>
            </HStack>
          )}
          {route?.type === "route" && (
            <HStack xstyle={styles.route} gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting" weight="medium">
                Routed to{" "}
                <Tooltip
                  placement="above"
                  content={
                    route.probabilities && (
                      <Text type="supporting">
                        {Object.entries(route.probabilities)
                          .map(([name, score]) => `${name}: ${(score * 100).toFixed(2)}%`)
                          .join(" · ")}
                      </Text>
                    )
                  }
                >
                  {`${route.choice} model`}
                </Tooltip>
              </Text>
            </HStack>
          )}
          {content.map((item) => {
            if (item.type === "delegation")
              return (
                <DelegatedWork key={`plan-${item.id}`} plan={item.plan} events={turn.events} />
              );
            if (item.type === "tools")
              return (
                <ToolCalls
                  key={`tools-${item.id}`}
                  calls={toolsWithResults(item.calls, turn.events)}
                  running={running}
                />
              );
            return (
              <Markdown key={`text-${item.id}`} density="compact" xstyle={styles.answer}>
                {item.text}
              </Markdown>
            );
          })}
          {approvals.length > 0 && (
            <ApprovalCard
              key={approvals.map((a) => a.id).join(",")}
              approvals={approvals}
              events={turn.events}
              busy={model.working || model.loading}
              submit={model.resume}
            />
          )}
          {metadata && <RunSummary run={metadata} />}
          {running && (
            <Text type="supporting" role="status">
              Working…
            </Text>
          )}
        </VStack>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

const styles = stylex.create({
  route: { marginBottom: "var(--spacing-1)" },
  answer: { marginTop: "var(--spacing-4)" },
});
