import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { RefreshCw, TerminalSquare } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import * as stylex from "@stylexjs/stylex";
import type { Thread } from "../../../shared/contracts/types";

interface Sandbox {
  threadId: string;
  containerId: string | null;
  status: "running" | "stopped" | "missing" | "expired" | "provisioning" | "unavailable";
  createdAt: string | null;
  lastUsedAt: string;
  expiredAt: string | null;
}

/** Display Wingman-owned containers and their read-only live command output. */
export function SandboxView({ threads }: { threads: Thread[] }) {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
          description="Set COMMAND_EXECUTION_TARGET=sandbox and restart the server."
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
        <div {...stylex.props(styles.layout)}>
          <div {...stylex.props(styles.list)} aria-label="Sandboxes">
            {sandboxes.map((item) => {
              const title =
                threads.find((thread) => thread.id === item.threadId)?.title ??
                `Conversation ${item.threadId.slice(0, 8)}`;
              return (
                <button
                  type="button"
                  key={item.threadId}
                  onClick={() => setSelected(item.threadId)}
                  aria-pressed={selected === item.threadId}
                  {...stylex.props(styles.item, selected === item.threadId && styles.itemSelected)}
                >
                  <span {...stylex.props(styles.itemTitle)}>{title}</span>
                  <span {...stylex.props(styles.metadata)}>
                    {item.status} ·{" "}
                    {item.containerId ? item.containerId.slice(0, 12) : "No container"}
                  </span>
                  <span {...stylex.props(styles.metadata)}>
                    Last used {new Date(item.lastUsedAt).toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
          <div {...stylex.props(styles.details)}>
            {selectedSandbox ? (
              <>
                <HStack gap={2} vAlign="center">
                  <Icon icon={TerminalSquare} />
                  <Text weight="medium">Command output</Text>
                  <Text type="supporting">Read-only · {selectedSandbox.status}</Text>
                </HStack>
                <Text type="supporting">
                  {selectedSandbox.createdAt &&
                    `Created ${new Date(selectedSandbox.createdAt).toLocaleString()} · `}
                  Last used {new Date(selectedSandbox.lastUsedAt).toLocaleString()}
                </Text>
                {selectedSandbox.expiredAt && (
                  <Text type="supporting">
                    Expired {new Date(selectedSandbox.expiredAt).toLocaleString()} · Temporary files
                    were removed.
                  </Text>
                )}
                <Text type="supporting">
                  Recent output is retained only while the server is running. Commands run through
                  Wingman, not this view.
                </Text>
                <SandboxTerminal threadId={selectedSandbox.threadId} />
              </>
            ) : (
              <Text type="supporting">Select a sandbox to view its output.</Text>
            )}
          </div>
        </div>
      )}
    </VStack>
  );
}

/** Attach a terminal renderer to the read-only output stream, disposing it on navigation. */
function SandboxTerminal({ threadId }: { threadId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    if (!element.current) return;
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      scrollback: 3000,
      fontSize: 13,
      theme: { background: "#141414", foreground: "#e5e5e5" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    terminal.textarea?.setAttribute("readonly", "");
    terminal.textarea?.setAttribute("aria-label", "Read-only sandbox terminal");
    fit.fit();
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* Hidden during layout. */
      }
    });
    observer.observe(element.current);
    const source = new EventSource(`/api/sandboxes/${encodeURIComponent(threadId)}/output`);
    let placeholder = false;
    source.onopen = () => {
      terminal.reset();
      placeholder = false;
      setStatus("Live");
    };
    source.onerror = () => setStatus("Reconnecting…");
    source.addEventListener("output", (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data) as { text?: unknown };
        if (typeof value.text === "string") {
          if (!value.text) {
            terminal.writeln("Waiting for command output…");
            placeholder = true;
          } else {
            if (placeholder) terminal.reset();
            placeholder = false;
            terminal.write(value.text);
          }
        }
      } catch {
        setStatus("Invalid output received");
      }
    });
    return () => {
      source.close();
      observer.disconnect();
      terminal.dispose();
    };
  }, [threadId]);
  return (
    <>
      <Text type="supporting" role="status">
        {status}
      </Text>
      <div ref={element} aria-label="Read-only sandbox output" {...stylex.props(styles.terminal)} />
    </>
  );
}

const styles = stylex.create({
  page: { padding: "var(--spacing-6)", maxWidth: 1200, marginInline: "auto" },
  heading: { fontSize: "calc(var(--text-large-size) * 1.5)", lineHeight: 1.3 },
  layout: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (min-width: 850px)": "minmax(240px, 320px) minmax(0, 1fr)",
    },
    gap: "var(--spacing-4)",
    width: "100%",
  },
  list: { display: "flex", flexDirection: "column", gap: "var(--spacing-2)" },
  item: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "var(--spacing-1)",
    padding: "var(--spacing-3)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-container)",
    backgroundColor: "transparent",
    color: "var(--color-text-primary)",
    textAlign: "left",
    cursor: "pointer",
    width: "100%",
  },
  itemSelected: { backgroundColor: "var(--color-background-muted)" },
  itemTitle: { fontWeight: 600 },
  metadata: { color: "var(--color-text-secondary)", fontSize: "var(--text-supporting-size)" },
  details: { display: "flex", flexDirection: "column", gap: "var(--spacing-3)", minWidth: 0 },
  terminal: {
    height: 360,
    minWidth: 0,
    padding: "var(--spacing-3)",
    backgroundColor: "#141414",
    borderRadius: "var(--radius-container)",
    overflow: "hidden",
  },
});
