import { ApiError, defaultConnection } from "./client";
import type { Connection } from "./types";

export interface ScheduledTask {
  id: string;
  prompt: string;
  threadId: string | null;
  nextRunAt: string | null;
  repeatInterval: string | null;
  state: "running" | "scheduled" | "queued" | "completed" | "failed" | "repeating" | "paused";
}
export interface TaskPage {
  schedulerEnabled: boolean;
  tasks: ScheduledTask[];
  nextCursor: string | null;
}

export function createTasksApi(
  connection: Connection = defaultConnection,
  fetcher: typeof fetch = fetch,
) {
  async function request<T>(path: string, signal: AbortSignal, method = "GET"): Promise<T> {
    const response = await fetcher(`${connection.url}/tasks${path}`, {
      method,
      credentials: "same-origin",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new ApiError(
        response.status,
        typeof data?.message === "string" ? data.message : `Request failed (${response.status}).`,
      );
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }
  return {
    list: (signal: AbortSignal, cursor?: string) =>
      request<TaskPage>(
        `?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal,
      ),
    cancel: (id: string, signal: AbortSignal) =>
      request<void>(`/${encodeURIComponent(id)}`, signal, "DELETE"),
  };
}
