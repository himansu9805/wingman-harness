import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { RefreshCw, TerminalSquare, MoreHorizontal } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import * as stylex from "@stylexjs/stylex";
import type { Thread } from "../../../shared/contracts/types";
import { List, ListItem } from "@astryxdesign/core/List";
import { Badge } from "@astryxdesign/core/Badge";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SandboxTerminal } from "./SandboxTerminal";

interface Sandbox {
  threadId: string;
  name: string;
  containerId: string | null;
  status: "running" | "stopped" | "missing" | "expired" | "provisioning" | "unavailable";
  sessionStatus: "ready" | "running" | "needs_reset" | "inactive" | "remote" | "unavailable";
  createdAt: string | null;
  lastUsedAt: string;
  expiredAt: string | null;
}

const statusVariants: Record<Sandbox["status"], "green" | "neutral" | "orange" | "red" | "blue"> = {
  running: "green",
  stopped: "neutral",
  missing: "orange",
  expired: "orange",
  provisioning: "blue",
  unavailable: "red",
};

/** Display Wingman-owned containers and their read-only live command output. */
export function SandboxView({ threads }: { threads: Thread[] }) {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<{ threadId: string; kind: "stop" | "remove" } | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (quiet = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/sandboxes", {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const result: { enabled: boolean; sandboxes: Sandbox[] } = await response.json();
      if (controller.signal.aborted) return;
      setEnabled(result.enabled);
      setSandboxes(result.sandboxes);
      setSelected((current) =>
        result.sandboxes.some((item) => item.threadId === current) ? current : null,
      );
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not load sandboxes");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(true), 10_000);
    return () => {
      clearInterval(timer);
      request.current?.abort();
    };
  }, [refresh]);
  const selectedSandbox = sandboxes.find((item) => item.threadId === selected);
  const performAction = async () => {
    if (!action || actionPending) return;
    setActionPending(true);
    try {
      const path = `/api/sandboxes/${encodeURIComponent(action.threadId)}`;
      const response = await fetch(action.kind === "stop" ? `${path}/stop` : path, {
        method: action.kind === "stop" ? "POST" : "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setAction(null);
      if (selected === action.threadId) setSelected(null);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sandbox");
      setAction(null);
    } finally {
      setActionPending(false);
    }
  };
  return (
    <VStack gap={6} width="100%" xstyle={styles.page}>
      <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
        <VStack gap={1}>
          <Text as="h1" weight="medium" xstyle={styles.heading}>
            Sandbox
          </Text>
          <Text type="supporting">View conversation containers and live command output.</Text>
        </VStack>
        <Button
          label="Refresh sandboxes"
          variant="ghost"
          isIconOnly
          icon={<Icon icon={RefreshCw} />}
          isLoading={loading}
          onClick={() => void refresh()}
        />
      </HStack>
      {!enabled && (
        <Banner
          status="warning"
          title="Sandbox execution is disabled"
          description="Sandbox monitoring is unavailable. Check the server configuration."
        />
      )}
      {error && (
        <Banner status="error" role="alert" title="Could not load sandboxes" description={error} />
      )}
      {enabled && !loading && sandboxes.length === 0 && (
        <Text type="supporting">Sandboxes appear after a conversation runs its first command.</Text>
      )}
      {sandboxes.length === 100 && (
        <Text type="supporting">Showing the 100 most recently used sandboxes.</Text>
      )}
      {sandboxes.length > 0 && (
        <VStack gap={4} width="100%">
          <List
            hasDividers
            density="spacious"
            edge="padded"
            aria-label="Sandboxes"
            xstyle={styles.list}
          >
            {sandboxes.map((item) => {
              const title =
                threads.find((thread) => thread.id === item.threadId)?.title ||
                `Conversation ${item.threadId.slice(0, 8)}`;
              const container = item.containerId
                ? `Container ${item.containerId.slice(0, 12)}`
                : "No container";
              const created = item.createdAt
                ? `Created ${new Date(item.createdAt).toLocaleString()}`
                : "Creation time unavailable";
              return (
                <ListItem
                  key={item.threadId}
                  align="center"
                  startContent={
                    <HStack vAlign="center" hAlign="center" xstyle={styles.sandboxIcon}>
                      <Icon icon={TerminalSquare} />
                    </HStack>
                  }
                  label={
                    <Text weight="medium" maxLines={2}>
                      {item.name}
                    </Text>
                  }
                  description={
                    <Text type="supporting" maxLines={2}>
                      {title} · {container} · {created}
                    </Text>
                  }
                  endContent={
                    <HStack gap={3} vAlign="center" xstyle={styles.rowEnd}>
                      {item.sessionStatus === "needs_reset" && (
                        <Badge label="Reset required" variant="orange" />
                      )}
                      <Badge
                        label={item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                        variant={statusVariants[item.status]}
                      />
                      <Button
                        label="View output"
                        variant="ghost"
                        onClick={() => setSelected(item.threadId)}
                      />
                      <MoreMenu
                        label={`Sandbox actions for ${item.name}`}
                        icon={<Icon icon={MoreHorizontal} />}
                        alignment="end"
                        presentation="adaptive"
                        items={[
                          {
                            label: "Stop container",
                            isDisabled: item.status !== "running",
                            onClick: () => setAction({ threadId: item.threadId, kind: "stop" }),
                          },
                          {
                            label: "Remove container",
                            variant: "destructive",
                            onClick: () => setAction({ threadId: item.threadId, kind: "remove" }),
                          },
                        ]}
                      />
                    </HStack>
                  }
                />
              );
            })}
          </List>
          {selectedSandbox && (
            <Dialog
              isOpen
              purpose="info"
              width={800}
              padding={4}
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            >
              <DialogHeader
                title="Sandbox output"
                subtitle={
                  threads.find((thread) => thread.id === selectedSandbox.threadId)?.title ||
                  `Conversation ${selectedSandbox.threadId.slice(0, 8)}`
                }
                onOpenChange={(open) => {
                  if (!open) setSelected(null);
                }}
              />
              <VStack gap={3} width="100%">
                {selectedSandbox.sessionStatus === "needs_reset" && (
                  <Banner
                    status="warning"
                    title="Sandbox reset required"
                    description="A previous command has an uncertain outcome. Stop or remove the sandbox before running another command."
                  />
                )}
                <SandboxTerminal threadId={selectedSandbox.threadId} />
              </VStack>
            </Dialog>
          )}
        </VStack>
      )}
      {action && (
        <Dialog
          isOpen
          purpose="form"
          padding={6}
          onOpenChange={(open) => {
            if (!open && !actionPending) setAction(null);
          }}
        >
          <DialogHeader
            title={action.kind === "stop" ? "Stop this sandbox?" : "Remove this sandbox?"}
          />
          <VStack gap={4}>
            <Text>
              Temporary files in this sandbox will be lost. The conversation will remain available.
            </Text>
            <Text type="supporting">
              {action.kind === "stop"
                ? "A later command will restart the sandbox."
                : "A later command will create a new sandbox."}
            </Text>
            <Text type="supporting">
              Wingman waits for any active command to finish before continuing.
            </Text>
            <HStack gap={3} hAlign="end">
              <Button
                label="Cancel"
                variant="ghost"
                isDisabled={actionPending}
                onClick={() => setAction(null)}
              />
              <Button
                label={action.kind === "stop" ? "Stop container" : "Remove container"}
                isLoading={actionPending}
                onClick={() => void performAction()}
              />
            </HStack>
          </VStack>
        </Dialog>
      )}
    </VStack>
  );
}

const styles = stylex.create({
  page: { padding: "var(--spacing-8)", maxWidth: 1200, marginInline: "auto" },
  heading: { fontSize: "calc(var(--text-large-size) * 1.5)", lineHeight: 1.3 },
  list: {
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-container)",
    overflow: "hidden",
    width: "100%",
  },
  sandboxIcon: {
    width: "var(--spacing-10)",
    height: "var(--spacing-10)",
    borderRadius: "var(--radius-container)",
    backgroundColor: "var(--color-background-muted)",
    flexShrink: 0,
  },
  rowEnd: { flexShrink: 0 },
});
