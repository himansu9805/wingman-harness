import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { SandboxMonitor, SandboxOutputCursor, SandboxOutputEvent } from "@wingman/core";
import { parse, ThreadId } from "../threads/schemas";

const MAX_BUFFERED = 262_144;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Attach the authenticated, read-only sandbox output stream to an HTTP server. */
export function attachSandboxWebSocket(
  server: Server,
  getMonitor: () => SandboxMonitor | undefined,
  token: string,
  signal: AbortSignal,
  allowedOrigin: string,
): void {
  if (!token) throw new Error("WINGMAN_API_TOKEN must be set");
  const expected = digest(token);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const reject = (socket: Socket, status: string) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/sandboxes\/([\w-]{1,64})\/output\/ws\/?$/.exec(url.pathname);
    if (!match) return;
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) {
      reject(socket, "403 Forbidden");
      return;
    }
    const header = request.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(digest(given), expected)) {
      reject(socket, "401 Unauthorized");
      return;
    }
    let threadId: string;
    try {
      threadId = parse(ThreadId, match[1]!);
    } catch {
      reject(socket, "400 Bad Request");
      return;
    }
    const monitor = getMonitor();
    if (!monitor) {
      reject(socket, "404 Not Found");
      return;
    }
    const rawCursor = url.searchParams.get("after");
    let cursor: SandboxOutputCursor | null = null;
    if (rawCursor !== null) {
      const parsed = /^([a-f0-9-]{36}):(\d+)$/.exec(rawCursor);
      if (!parsed || !Number.isSafeInteger(Number(parsed[2]))) {
        reject(socket, "400 Bad Request");
        return;
      }
      cursor = { generation: parsed[1]!, sequence: Number(parsed[2]) };
    }
    socket.pause();
    let subscription: Awaited<ReturnType<SandboxMonitor["subscribeEvents"]>> | undefined;
    socket.once("close", () => subscription?.unsubscribe());
    socket.on("error", () => subscription?.unsubscribe());
    const pending: SandboxOutputEvent[] = [];
    let pendingSize = 0;
    let live: WebSocket | undefined;
    let overflow = false;
    const send = (event: SandboxOutputEvent) => {
      if (!live) {
        pendingSize += event.text.length;
        if (pendingSize > MAX_BUFFERED) {
          overflow = true;
          return;
        }
        pending.push(event);
      } else if (live.readyState === WebSocket.OPEN) {
        const frame = JSON.stringify({ type: "output", ...event });
        if (live.bufferedAmount + Buffer.byteLength(frame) > MAX_BUFFERED)
          live.close(1013, "Output buffer exceeded");
        else live.send(frame);
      }
    };
    void monitor
      .subscribeEvents(threadId, cursor, send)
      .then((value) => {
        subscription = value;
        if (socket.destroyed || signal.aborted || overflow) {
          value.unsubscribe();
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          live = client;
          client.on("close", () => value.unsubscribe());
          client.on("error", () => value.unsubscribe());
          client.on("message", (data, isBinary) => {
            try {
              if (isBinary) throw new Error("Invalid message");
              const message: unknown = JSON.parse(data.toString());
              if (!message || typeof message !== "object" || Array.isArray(message))
                throw new Error("Invalid message");
              const value = message as Record<string, unknown>;
              if (
                value.type !== "resize" ||
                Object.keys(value).some((key) => !["type", "cols", "rows"].includes(key)) ||
                !Number.isInteger(value.cols) ||
                !Number.isInteger(value.rows) ||
                (value.cols as number) < 20 ||
                (value.cols as number) > 500 ||
                (value.rows as number) < 5 ||
                (value.rows as number) > 200
              )
                throw new Error("Invalid dimensions");
              void monitor
                .resize(threadId, value.cols as number, value.rows as number)
                .then(() => {
                  if (client.readyState === WebSocket.OPEN)
                    client.send(
                      JSON.stringify({
                        type: "resize.accepted",
                        cols: value.cols,
                        rows: value.rows,
                      }),
                    );
                })
                .catch(() => client.close(1011, "Resize failed"));
            } catch {
              client.close(1008, "Only terminal resize is allowed");
            }
          });
          client.send(JSON.stringify({ type: "ready", cursor: value.cursor, gap: value.gap }));
          for (const event of value.events) send(event);
          for (const event of pending) send(event);
          pending.length = 0;
        });
        socket.resume();
      })
      .catch(() => {
        subscription?.unsubscribe();
        if (!socket.destroyed) reject(socket, "404 Not Found");
      });
  };
  server.on("upgrade", upgrade);
  signal.addEventListener(
    "abort",
    () => {
      server.off("upgrade", upgrade);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
    { once: true },
  );
}
