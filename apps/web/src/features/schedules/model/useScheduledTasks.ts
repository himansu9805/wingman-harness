import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTasksApi, type ScheduledTask } from "../api/tasks";
import { defaultConnection, ApiError } from "../../../shared/api/connection";
import type { Connection } from "../../../shared/contracts/types";

/** Extract an error message or supply a user-facing fallback for unknown failures. */
const explain = (error: unknown) => (error instanceof Error ? error.message : "Request failed.");
type Page<T> = { items: T[]; nextCursor: string | null };

/** Paged task loading rejects responses from an earlier connection. */
function usePages<T extends { id: string }>(
  fetchPage: (signal: AbortSignal, cursor?: string) => Promise<Page<T>>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scope = useRef(new AbortController());
  const busy = useRef<AbortController | null>(null);
  const cursor = useRef<string | null>(null);
  /** Fetch or append a page while rejecting overlapping loads and stale lifecycle responses. */
  const load = useCallback(
    async (more = false, controller = scope.current) => {
      if (controller.signal.aborted || busy.current === controller || (more && !cursor.current))
        return;
      busy.current = controller;
      setLoading(true);
      try {
        const page = await fetchPage(controller.signal, more ? cursor.current! : undefined);
        if (controller.signal.aborted || scope.current !== controller) return;
        setItems((old) =>
          more
            ? [...new Map([...old, ...page.items].map((item) => [item.id, item])).values()]
            : page.items,
        );
        cursor.current = page.nextCursor;
        setNextCursor(page.nextCursor);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted && scope.current === controller) setError(explain(error));
      } finally {
        if (scope.current === controller) {
          setLoading(false);
          busy.current = null;
        }
      }
    },
    [fetchPage],
  );
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    cursor.current = null;
    setNextCursor(null);
    setItems([]);
    setError("");
    void load(false, controller);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(false, controller);
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  return {
    items,
    nextCursor,
    loading,
    error,
    /** Reload the first page. */
    refresh: () => load(),
    /** Append the next page when a cursor is available. */
    more: () => load(true),
    /** Remove a task from the displayed page collection. */
    remove: (id: string) => setItems((old) => old.filter((item) => item.id !== id)),
  };
}

/** Load scheduled tasks and coordinate cancellation, preserving removal across stale list responses. */
export function useScheduledTasks(connection: Connection = defaultConnection) {
  const api = useMemo(() => createTasksApi(connection), [connection]);
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const removed = useRef(new Set<string>());
  const scope = useRef(new AbortController());
  const mutation = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => controller.abort();
  }, []);
  /** Load a task page and omit tasks already cancelled locally. */
  const fetchTasks = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const page = await api.list(signal, cursor);
      if (!signal.aborted) setSchedulerEnabled(page.schedulerEnabled);
      return {
        items: page.tasks.filter((task) => !removed.current.has(task.id)),
        nextCursor: page.nextCursor,
      };
    },
    [api],
  );
  const tasks = usePages<ScheduledTask>(fetchTasks);
  /** Cancel future runs once, retain the chat, and refresh after success or an uncertain failure. */
  const cancel = async (task: ScheduledTask) => {
    if (mutation.current) return false;
    const signal = scope.current.signal;
    mutation.current = true;
    setCancelling(task.id);
    setActionError("");
    setNotice("");
    try {
      await api.cancel(task.id, signal);
      if (signal.aborted) return false;
      removed.current.add(task.id);
      tasks.remove(task.id);
      setNotice("Future runs cancelled. Results remain in the chat.");
      void tasks.refresh();
      return true;
    } catch (error) {
      if (!signal.aborted) {
        setActionError(
          explain(error) +
            (!(error instanceof ApiError)
              ? " Refresh the list before retrying; cancellation may have succeeded."
              : ""),
        );
        void tasks.refresh();
      }
      return false;
    } finally {
      mutation.current = false;
      if (!signal.aborted) setCancelling(null);
    }
  };
  return {
    tasks,
    schedulerEnabled,
    cancelling,
    actionError,
    notice,
    cancel,
    /** Dismiss cancellation feedback without changing the task list. */
    clearFeedback: () => {
      setActionError("");
      setNotice("");
    },
  };
}
export type ScheduledTasksModel = ReturnType<typeof useScheduledTasks>;
