import { ApiError } from "../../../shared/api/connection";
import type { Connection, ThreadEvent } from "../../../shared/contracts/types";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";
interface WatchOptions {
  connection: Connection;
  threadId: string;
  cursor?: string;
  signal: AbortSignal;
  /** Historical events are flagged until the server confirms its captured journal cursor. */
  onEvent: (event: ThreadEvent, id: string, replaying: boolean) => void;
  /** Publish accumulated replay state before live events are delivered. */
  onReplayComplete?: () => void;
  onStatus: (status: StreamStatus) => void;
  onError: (error: Error) => void;
  socketFactory?: (url: string) => WebSocket;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** Wait before reconnecting; reject promptly when the subscription is aborted. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    /** Release the abort listener before completing the reconnect delay. */
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    /** Cancel the reconnect timer and reject with the subscription’s abort reason. */
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Retries only the read subscription. Commands are never automatically resubmitted. */
export async function watchEvents(options: WatchOptions): Promise<void> {
  const { connection, threadId, signal, onEvent, onStatus, onError } = options;
  let cursor = options.cursor ?? "";
  let connected = false;
  let retry = 1_000;
  while (!signal.aborted) {
    let socket: WebSocket | undefined;
    try {
      onStatus(connected ? "reconnecting" : "connecting");
      connected = true;
      const base = typeof window === "undefined" ? "http://localhost" : window.location.href;
      const url = new URL(
        `${connection.url}/threads/${encodeURIComponent(threadId)}/events/ws`,
        base,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (cursor) url.searchParams.set("after", cursor);
      let replaying = true;
      await new Promise<void>((resolve, reject) => {
        socket = (options.socketFactory ?? ((address) => new WebSocket(address)))(url.href);
        const current = socket;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (current.readyState < 2) current.close();
          error ? reject(error) : resolve();
        };
        const abort = () => finish();
        signal.addEventListener("abort", abort, { once: true });
        current.onopen = () => {
          retry = 1_000;
        };
        current.onmessage = (message) => {
          if (settled) return;
          try {
            if (typeof message.data !== "string" || message.data.length > 1_000_000)
              throw new Error("Invalid event frame.");
            const frame = JSON.parse(message.data) as {
              type?: string;
              cursor?: unknown;
              id?: unknown;
              event?: ThreadEvent;
              status?: unknown;
              message?: unknown;
            };
            if (frame.type === "stream_error") {
              if (typeof frame.status !== "number") throw new Error("Invalid stream error.");
              finish(
                new ApiError(
                  frame.status,
                  typeof frame.message === "string" ? frame.message : "Event connection failed.",
                ),
              );
              return;
            }
            if (frame.type === "replay_complete") {
              if (!replaying || frame.cursor !== (cursor || `${threadId}:0`))
                throw new Error("Invalid replay boundary.");
              replaying = false;
              options.onReplayComplete?.();
              onStatus("live");
              return;
            }
            if (
              frame.type !== "event" ||
              typeof frame.id !== "string" ||
              !frame.id.startsWith(`${threadId}:`)
            )
              throw new Error("Event belongs to another thread.");
            const sequence = frame.id.slice(threadId.length + 1);
            if (!/^[1-9]\d{0,18}$/.test(sequence)) throw new Error("Invalid event ID.");
            if (cursor && BigInt(sequence) <= BigInt(cursor.slice(threadId.length + 1))) return;
            const payload = frame.event;
            if (!payload || typeof payload.type !== "string" || typeof payload.runId !== "string")
              throw new Error("Invalid event payload.");
            onEvent({ ...payload, sequence }, frame.id, replaying);
            cursor = frame.id;
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Invalid event frame."));
          }
        };
        current.onerror = () => {};
        current.onclose = (event) => {
          if (signal.aborted) finish();
          else if ([4400, 4401, 4403, 4404].includes(event.code))
            finish(new ApiError(event.code - 4000, event.reason || "Event connection rejected."));
          else finish(new Error("Event connection closed."));
        };
        if (signal.aborted) abort();
      });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) {
        onStatus("offline");
        onError(error);
        return;
      }
      onStatus("reconnecting");
    } finally {
      if (socket && socket.readyState < 2) socket.close();
    }
    if (signal.aborted) return;
    try {
      await (options.wait ?? wait)(retry, signal);
    } catch {
      return;
    }
    retry = Math.min(retry * 2, 15_000);
  }
}
