import type { Approval, Catalogue, Connection, History } from "../../../shared/contracts/types";

import { ApiError, defaultConnection } from "../../../shared/api/connection";

/** Create a conversation client using cancellable, time-limited requests without mutation retries. */
export function createApi(
  connection: Connection = defaultConnection,
  fetcher: typeof fetch = fetch,
) {
  /** Send a scoped API request, decode JSON or an empty response, and expose HTTP failures as ApiError. */
  async function request<T>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method?: string,
  ): Promise<T> {
    const response = await fetcher(`${connection.url}/threads${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const message =
        typeof data?.message === "string" ? data.message : `Request failed (${response.status}).`;
      throw new ApiError(response.status, message);
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }
  /** Encode a conversation ID as a single URL path segment. */
  const idPath = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    connection,
    /** List conversations using an optional catalogue cursor. */
    list: (signal: AbortSignal, cursor?: string) =>
      request<Catalogue>(
        `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal,
      ),
    /** Create a persisted conversation; the UI calls this when sending the first prompt. */
    create: (signal: AbortSignal) => request<{ id: string }>("", signal, {}),
    /** Delete the identified conversation. */
    remove: (id: string, signal: AbortSignal) =>
      request<void>(idPath(id), signal, undefined, "DELETE"),
    /** Fetch a page of saved messages for a conversation. */
    history: (id: string, signal: AbortSignal, cursor?: string) =>
      request<History>(
        `${idPath(id)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal,
      ),
    /** Fetch unresolved approvals for the conversation. */
    pending: (id: string, signal: AbortSignal) =>
      request<Approval[]>(`${idPath(id)}/pending`, signal),
    /** Submit a prompt and return its accepted run ID; results arrive through the event stream. */
    send: (id: string, message: string, signal: AbortSignal) =>
      request<{ runId: string }>(`${idPath(id)}/messages`, signal, { message }),
    /** Resume a paused run with decisions keyed by approval ID. */
    resume: (id: string, answers: Record<string, boolean>, signal: AbortSignal) =>
      request<{ runId: string }>(`${idPath(id)}/resume`, signal, { answers }),
  };
}
export type Api = ReturnType<typeof createApi>;
