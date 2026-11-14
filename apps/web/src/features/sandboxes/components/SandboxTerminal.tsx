import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import * as stylex from "@stylexjs/stylex";

/** Pick a terminal color for Wingman's lifecycle messages. */
function lifecycleColor(kind: string | undefined, exitCode: number | undefined): number | null {
  if (kind === "command.started") return 36;
  if (kind === "command.completed") return exitCode === 0 ? 32 : 31;
  if (kind === "command.uncertain" || kind === "session.reset") return 33;
  return null;
}

/** Attach a terminal renderer to the read-only output stream, disposing it on navigation. */
export function SandboxTerminal({ threadId }: { threadId: string }) {
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
      theme: {
        background: "#141414",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        black: "#242424",
        red: "#f07178",
        green: "#a6d189",
        yellow: "#e5c07b",
        blue: "#82aaff",
        magenta: "#c792ea",
        cyan: "#89ddff",
        white: "#e5e5e5",
        brightBlack: "#777777",
        brightRed: "#ff8b92",
        brightGreen: "#b9e99a",
        brightYellow: "#f5d492",
        brightBlue: "#a0bdff",
        brightMagenta: "#d7a8f5",
        brightCyan: "#a5eaff",
        brightWhite: "#ffffff",
      },
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
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const resize = () => {
      if (
        socket?.readyState === WebSocket.OPEN &&
        terminal.cols >= 20 &&
        terminal.cols <= 500 &&
        terminal.rows >= 5 &&
        terminal.rows <= 200
      )
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };
    const resizeListener = terminal.onResize(resize);
    let cursor: { generation: string; sequence: number } | null = null;
    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(
        `/api/sandboxes/${encodeURIComponent(threadId)}/output/ws`,
        `${protocol}//${window.location.host}`,
      );
      if (cursor) url.searchParams.set("after", `${cursor.generation}:${cursor.sequence}`);
      socket = new WebSocket(url);
      socket.onopen = () => {
        setStatus("Live");
        resize();
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as {
            type?: string;
            gap?: boolean;
            generation?: string;
            sequence?: number;
            text?: string;
            kind?: string;
            exitCode?: number;
          };
          if (event.type === "ready" && event.gap) {
            terminal.writeln("\r\n[Some earlier output is unavailable]\r\n");
            cursor = null;
          } else if (
            event.type === "output" &&
            typeof event.text === "string" &&
            typeof event.generation === "string" &&
            Number.isSafeInteger(event.sequence)
          ) {
            if (cursor && cursor.generation !== event.generation)
              terminal.writeln("\r\n[Sandbox output restarted]\r\n");
            const color = lifecycleColor(event.kind, event.exitCode);
            terminal.write(color === null ? event.text : `\x1b[${color}m${event.text}\x1b[0m`);
            cursor = { generation: event.generation, sequence: event.sequence! };
          }
        } catch {
          setStatus("Invalid output received");
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!closed) {
          setStatus("Reconnecting…");
          reconnect = setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
      observer.disconnect();
      resizeListener.dispose();
      terminal.dispose();
    };
  }, [threadId]);
  return (
    <VStack gap={2} width="100%">
      <HStack hAlign="between" vAlign="center" xstyle={styles.terminalMeta}>
        <Text type="supporting">Read-only terminal</Text>
        <Text type="supporting" role="status">
          {status}
        </Text>
      </HStack>
      <div ref={element} aria-label="Read-only sandbox output" {...stylex.props(styles.terminal)} />
    </VStack>
  );
}

const styles = stylex.create({
  terminalMeta: {
    width: "100%",
    paddingInline: "var(--spacing-1)",
  },
  terminal: {
    width: "100%",
    height: 360,
    minWidth: 0,
    padding: "var(--spacing-3)",
    backgroundColor: "#141414",
    borderRadius: "var(--radius-container)",
    overflow: "hidden",
  },
});
