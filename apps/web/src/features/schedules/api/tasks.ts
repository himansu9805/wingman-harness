import { ApiError, defaultConnection } from "../../../shared/api/connection";
import type { Connection } from "../../../shared/contracts/types";

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

/** Create a scheduled-task client for cursor-based listing and cancellation without retries. */
export function createTasksApi(
  connection: Connection = defaultConnection,
  fetcher: typeof fetch = fetch,
) {
  /** Send a scoped API request, decode JSON or an empty response, and expose HTTP failures as ApiError. */
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
    /** Fetch a page of tasks and the scheduler availability flag. */
    list: (signal: AbortSignal, cursor?: string) =>
      request<TaskPage>(
        `?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal,
      ),
    /** Cancel the identified scheduled task’s future runs. */
    cancel: (id: string, signal: AbortSignal) =>
      request<void>(`/${encodeURIComponent(id)}`, signal, "DELETE"),
  };
}
