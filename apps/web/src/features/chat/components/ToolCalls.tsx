import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import * as stylex from "@stylexjs/stylex";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { ChatToolCalls } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { toolLabel } from "../model/transcript";
import type { ToolCall } from "../../../shared/contracts/types";
import { ChevronDown, ChevronUp, Hammer, ToolCase } from "lucide-react";
import { Icon } from "@astryxdesign/core";

/** Render MCP text blocks and JSON previews without terminal styling. */
function outputDetail(output: string, name: string, truncated: boolean) {
  let display: string | undefined;
  try {
    const value: unknown = JSON.parse(output);
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((block) => block && block.type === "text" && typeof block.text === "string")
    ) {
      display = value
        .map((block) => {
          try {
            const parsed: unknown = JSON.parse(block.text);
            return typeof parsed === "object" && parsed !== null
              ? JSON.stringify(parsed, null, 2)
              : block.text;
          } catch {
            return block.text;
          }
        })
        .join("\n\n");
    } else if (value !== null && typeof value === "object") {
      display = JSON.stringify(value, null, 2);
    }
  } catch {
    if (truncated) {
      // MCP previews can end inside the JSON-encoded text field. Decode only
      // the available string prefix; never fabricate the missing JSON structure.
      const match = output.match(/^\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/);
      if (match) {
        const prefix = output.slice(match[0].length);
        for (let removed = 0; removed <= Math.min(6, prefix.length); removed++) {
          try {
            display = JSON.parse(`"${prefix.slice(0, prefix.length - removed)}"`) as string;
            break;
          } catch {
            // The truncation may split an escape sequence.
          }
        }
      }
      display ??= output;
    }
  }
  if (display !== undefined) {
    return (
      <Text as="p" xstyle={styles.json}>
        {display}
      </Text>
    );
  }
  return <CodeBlock code={output} language="text" title={`${name} output`} />;
}

/** Collapse long tool output while retaining its accessible full preview. */
function ToolOutput({ result, name }: { result: NonNullable<ToolCall["result"]>; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const content = useRef<HTMLElement>(null);
  const id = useId();

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      // The collapsed height is six lines at the inherited 1.5 line-height.
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      if (Number.isFinite(lineHeight)) setOverflows(element.scrollHeight > lineHeight * 6 + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [result.output]);

  return (
    <VStack gap={2}>
      <section
        id={id}
        ref={content}
        {...stylex.props(styles.output, !expanded && overflows && styles.collapsed)}
      >
        {outputDetail(result.output, name, result.truncated)}
      </section>
      {overflows && (
        <Button
          label={expanded ? "Show less" : "Show more"}
          variant="ghost"
          endContent={<Icon icon={expanded ? ChevronUp : ChevronDown} size="sm" />}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        />
      )}
      {result.truncated && <Text type="supporting">Output preview truncated by the server.</Text>}
    </VStack>
  );
}

/** Render collapsible tool activity with request arguments, outcomes, and group summaries. */
export function ToolCalls({
  calls,
  running,
  grouped = true,
}: {
  calls: ToolCall[];
  running: boolean;
  grouped?: boolean;
}) {
  const items = calls.map((call) => ({
    key: call.id,
    ...toolLabel(call),
    status: call.result
      ? ("complete" as const)
      : running
        ? ("running" as const)
        : ("pending" as const),
    stats: call.decision === false ? <Text type="supporting">Declined by user</Text> : undefined,
    resultDetail: call.result ? <ToolOutput result={call.result} name={call.name} /> : undefined,
  }));
  if (!grouped)
    return (
      <VStack gap={1}>
        {items.map((item) => (
          <ChatToolCalls key={item.key} xstyle={styles.calls} calls={[item]} />
        ))}
      </VStack>
    );
  if (items.length <= 1) return <ChatToolCalls xstyle={styles.calls} calls={items} />;
  const complete = calls.filter((call) => call.result !== undefined).length;
  const label =
    complete === calls.length
      ? `${calls.length} tool calls completed`
      : complete > 0
        ? `${complete} of ${calls.length} tool calls completed`
        : `${calls.length} tool calls ${running ? "running" : "pending"}`;
  return (
    <Collapsible
      style={styles.calls}
      defaultIsOpen={false}
      trigger={
        <HStack gap={2}>
          <Icon icon={Hammer} size="sm" />
          <Text type="supporting" weight="medium">
            {label}
          </Text>
        </HStack>
      }
    >
      <VStack gap={0}>
        {items.map((item) => (
          <ChatToolCalls key={item.key} xstyle={styles.calls} calls={[item]} />
        ))}
      </VStack>
    </Collapsible>
  );
}

const styles = stylex.create({
  calls: { margin: 0 },
  output: { width: "100%", lineHeight: 1.5 },
  collapsed: {
    maxHeight: "9em",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
  },
  json: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-family-code)" },
});
