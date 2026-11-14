import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { AgentService } from "../agent/agent.service";
import { parse, ThreadId } from "./schemas";
import { validateSequence } from "./thread-events.repository";

const digest = (value: string) => createHash("sha256").update(value).digest();
const MAX_BUFFERED = 1024 * 1024;

/** Serve durable conversation events over authenticated, read-only WebSockets. */
export function attachThreadEventsWebSocket(
  server: Server,
  agent: AgentService,
  token: string,
  allowedOrigin: string,
): void {
  if (!token) throw new Error("WINGMAN_API_TOKEN must be set");
  const expected = digest(token);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const reject = (socket: Socket, status: string) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/threads\/([\w-]{1,64})\/events\/ws\/?$/.exec(url.pathname);
    if (!match) return;
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) {
      reject(socket, "403 Forbidden");
      return;
    }
    const header = request.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    const authorized = timingSafeEqual(digest(given), expected);
    let threadId = "";
    let cursor = "0";
    let invalid = false;
    try {
      threadId = parse(ThreadId, match[1]!);
      const supplied = url.searchParams.get("after");
      if (supplied !== null) {
        const prefix = `${threadId}:`;
        if (!supplied.startsWith(prefix)) throw new Error("Invalid cursor");
        cursor = supplied.slice(prefix.length);
        validateSequence(cursor);
      }
    } catch {
      invalid = true;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      if (!authorized) {
        client.close(4401, "Unauthorized");
        return;
      }
      if (invalid) {
        client.close(4400, "Invalid cursor");
        return;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, agent.shutdownSignal]);
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) {
          client.terminate();
          return;
        }
        alive = false;
        client.ping();
      }, 15_000);
      heartbeat.unref();
      client.on("pong", () => {
        alive = true;
      });
      client.on("close", () => {
        clearInterval(heartbeat);
        controller.abort();
      });
      client.on("error", () => controller.abort());
      client.on("message", () => client.close(1008, "Read-only stream"));
      const send = async (frame: unknown) => {
        signal.throwIfAborted();
        const payload = JSON.stringify(frame);
        if (
          client.readyState !== WebSocket.OPEN ||
          client.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFERED
        )
          throw new Error("Event client is too slow or disconnected");
        await new Promise<void>((resolve, rejectSend) =>
          client.send(payload, (error) => (error ? rejectSend(error) : resolve())),
        );
      };
      void (async () => {
        try {
          try {
            await agent.requireThread(threadId);
          } catch (error) {
            if (!(error instanceof NotFoundException) && !(error instanceof ConflictException))
              throw error;
            await send({ type: "stream_error", status: 404, message: "Conversation not found" });
            client.close(4404, "Conversation not found");
            return;
          }
          const replayThrough = await agent.events.latest(threadId);
          if (BigInt(cursor) > BigInt(replayThrough)) {
            await send({
              type: "stream_error",
              status: 400,
              message: "Event cursor is ahead of this conversation",
            });
            client.close(4400, "Invalid cursor");
            return;
          }
          let replaying = true;
          const completeReplay = async () => {
            if (!replaying) return;
            await send({ type: "replay_complete", cursor: `${threadId}:${replayThrough}` });
            replaying = false;
          };
          while (!signal.aborted) {
            try {
              await agent.requireThread(threadId);
            } catch (error) {
              if (!(error instanceof NotFoundException) && !(error instanceof ConflictException))
                throw error;
              await send({ type: "stream_error", status: 404, message: "Conversation not found" });
              client.close(4404, "Conversation not found");
              return;
            }
            if (BigInt(cursor) >= BigInt(replayThrough)) await completeReplay();
            const rows = await agent.events.listAfter(threadId, cursor, 100);
            for (const row of rows) {
              if (BigInt(row.sequence) > BigInt(replayThrough)) await completeReplay();
              await send({
                type: "event",
                id: `${threadId}:${row.sequence}`,
                event: { ...row.payload, runId: row.runId, createdAt: row.createdAt },
              });
              cursor = row.sequence;
            }
            if (BigInt(cursor) >= BigInt(replayThrough)) await completeReplay();
            if (rows.length < 100) await delay(100, undefined, { signal });
          }
        } catch {
          if (client.readyState === WebSocket.OPEN) client.close(1011, "Event stream interrupted");
        } finally {
          controller.abort();
        }
      })();
    });
  };
  server.on("upgrade", upgrade);
  agent.shutdownSignal.addEventListener(
    "abort",
    () => {
      server.off("upgrade", upgrade);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
    { once: true },
  );
}
