import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi } from "../api/client";
import { ApiError } from "../../../shared/api/connection";
import { watchEvents, type StreamStatus } from "../api/events";
import type {
  Approval,
  ThreadEvent,
  Connection,
  History,
  Message,
  Thread,
} from "../../../shared/contracts/types";
import { applyEvent, emptyActivity, prependActivity } from "./events";
import { saveThread, selectedThread } from "./storage";

/** Extract an error message or supply a user-facing fallback for unknown failures. */
const explain = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
/** Manage conversation selection, optimistic messages, durable events, approvals, and catalogue refreshes. Stale requests are aborted when the connection or selected conversation changes. */
export function useWingman(connection: Connection | null) {
  const api = useMemo(() => (connection ? createApi(connection) : null), [connection]);
  const [threads, setThreads] = useState<Thread[]>([]);
  // Generated titles are final: replay and older catalogue requests must not restore a fallback.
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const titledThreads = useMemo(
    () =>
      threads.map((thread) =>
        titles.has(thread.id) ? { ...thread, title: titles.get(thread.id)! } : thread,
      ),
    [threads, titles],
  );
  const [catalogueCursor, setCatalogueCursor] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(selectedThread);
  const [history, setHistory] = useState<History>({ messages: [], nextCursor: null });
  const [pending, setPending] = useState<Approval[]>([]);
  const [activity, setActivity] = useState(emptyActivity);
  const [stream, setStream] = useState<StreamStatus>("offline");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const selectedId = useRef(threadId);
  selectedId.current = threadId;
  const lifecycle = useRef(new AbortController());
  const threadLifecycle = useRef(new AbortController());
  const seenRuns = useRef(new Set<string>());
  const refreshThread = useRef<() => Promise<void>>(async () => {});
  const actionInFlight = useRef(false);
  const createdThread = useRef<string | null>(null);
  const optimistic = useRef<{ message: Message; previousIds: Set<string> } | null>(null);

  /** Select a conversation and immediately abort writes belonging to the previous selection. */
  const select = useCallback((id: string | null) => {
    if (selectedId.current === id) return;
    selectedId.current = id;
    threadLifecycle.current.abort(); // Reject stale writes immediately, before React runs the next effect.
    setThreadId(id);
    saveThread(id);
    setError("");
  }, []);

  /** Refresh or append catalogue entries, ignoring results from an aborted connection. */
  const refreshThreads = useCallback(
    async (more = false) => {
      if (!api) return;
      const signal = lifecycle.current.signal;
      try {
        const page = await api.list(signal, more ? (catalogueCursor ?? undefined) : undefined);
        if (signal.aborted) return;
        setThreads((old) =>
          more
            ? [...new Map([...old, ...page.threads].map((t) => [t.id, t])).values()]
            : page.threads,
        );
        setCatalogueCursor(page.nextCursor);
      } catch (e) {
        if (!signal.aborted) setError(explain(e));
      }
    },
    [api, catalogueCursor],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setThreads([]);
    setTitles(new Map());
    setCatalogueCursor(null);
    if (!api) {
      setThreadId(null);
      setStream("offline");
      return () => controller.abort();
    }
    /** Refresh the conversation catalogue unless this connection’s lifecycle has ended. */
    async function poll() {
      try {
        const page = await api!.list(controller.signal);
        if (!controller.signal.aborted) {
          setThreads(page.threads);
          setCatalogueCursor(page.nextCursor);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(explain(e));
      }
    }
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    threadLifecycle.current = controller;
    const { signal } = controller;
    const handoff = threadId !== null && createdThread.current === threadId;
    createdThread.current = null;
    if (!handoff) {
      setHistory({ messages: [], nextCursor: null });
      setActivity(emptyActivity);
      optimistic.current = null;
    }
    setPending([]);
    setStream("offline");
    setLoading(Boolean(api && threadId));
    setWorking(false);
    seenRuns.current = new Set();
    if (!api || !threadId) {
      refreshThread.current = async () => {};
      return () => controller.abort();
    }
    let restoredActivity = handoff ? activity : emptyActivity;
    let restoredPending: Approval[] | undefined;
    let restoredError: string | undefined;
    /** Reconcile a saved page with the optimistic prompt. */
    const publishHistory = ({ messages, nextCursor }: History, preserveOlder = false) => {
      const local = optimistic.current;
      if (
        local &&
        messages.some(
          (message) =>
            message.role === "user" &&
            message.text === local.message.text &&
            !local.previousIds.has(message.id),
        )
      )
        optimistic.current = null;
      const optimisticMessage = optimistic.current?.message;
      setHistory((old) => {
        const overlap =
          preserveOlder && messages.length
            ? old.messages.findIndex((message) => message.id === messages[0].id)
            : -1;
        const earlier = overlap > 0 ? old.messages.slice(0, overlap) : [];
        return {
          messages: [...earlier, ...messages, ...(optimisticMessage ? [optimisticMessage] : [])],
          nextCursor: overlap >= 0 ? old.nextCursor : nextCursor,
        };
      });
    };
    const publishSignals = () => {
      if (restoredPending !== undefined) setPending(restoredPending);
      if (restoredError !== undefined) setError(restoredError);
      restoredPending = undefined;
      restoredError = undefined;
    };
    const reportError = (error: unknown) => {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === 404) select(null);
      setError(explain(error));
    };
    let refreshing = false;
    let again = false;
    /** Coalesce history refreshes and reconcile saved messages with the optimistic prompt. */
    const refresh = async () => {
      if (refreshing) {
        again = true;
        return;
      }
      refreshing = true;
      try {
        do {
          again = false;
          const [messages, approvals] = await Promise.all([
            api.history(threadId, signal),
            api.pending(threadId, signal),
          ]);
          if (signal.aborted) return;
          publishHistory(messages, true);
          setPending(approvals);
        } while (again && !signal.aborted);
      } catch (error) {
        reportError(error);
      } finally {
        refreshing = false;
      }
    };
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** Open a page from its snapshot, then subscribe strictly after its watermark. */
    const open = async () => {
      setStream("connecting");
      try {
        const [snapshot, approvals] = await Promise.all([
          api.snapshot(threadId, signal),
          api.pending(threadId, signal),
        ]);
        if (signal.aborted) return;
        for (const event of snapshot.activity.events) restoreEvent(event);
        publishHistory(snapshot);
        restoredPending = approvals;
        setActivity(restoredActivity);
        publishSignals();
        refreshThread.current = refresh;
        setLoading(false);
        void subscribe(snapshot.activity.cursor);
      } catch (error) {
        if (signal.aborted) return;
        setStream("offline");
        setLoading(false);
        reportError(error);
      }
    };
    const subscribe = (cursor: string) =>
      watchEvents({
        connection: api.connection,
        threadId,
        signal,
        cursor,
        onStatus: (status) => {
          if (!signal.aborted) setStream(status);
        },
        onError: reportError,
        onReplayComplete: () => {
          if (signal.aborted) return;
          setActivity((old) => prependActivity(restoredActivity, old.events));
          publishSignals();
          void refresh();
        },
        onEvent: (event, _id, replaying) => {
          if (signal.aborted) return;
          restoreEvent(event);
          if (replaying || event.type === "thread_title") return;
          setActivity((old) => applyEvent(old, event));
          publishSignals();
          if (["done", "approval", "error", "tool_result"].includes(event.type)) {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => void refresh(), 75);
          }
        },
      });
    /** Update journal state in sequence without exposing intermediate reconnect events. */
    const restoreEvent = (event: ThreadEvent) => {
      if (event.type === "thread_title") {
        setTitles((old) => new Map(old).set(threadId, event.title));
        return;
      }
      seenRuns.current.add(event.runId);
      if (seenRuns.current.size > 500)
        seenRuns.current.delete(seenRuns.current.values().next().value!);
      restoredActivity = applyEvent(restoredActivity, event);
      if (event.type === "approval") restoredPending = event.approvals;
      if (event.type === "done" || event.type === "error") restoredPending = [];
      if (event.type === "done") restoredError = "";
      if (event.type === "error") restoredError = event.message;
    };
    refreshThread.current = async () => {};
    void open();
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
    };
  }, [api, threadId, select]);

  /** Serialize mutations within a lifecycle and surface uncertain transport outcomes without retrying. */
  const perform = async (
    action: (signal: AbortSignal) => Promise<void>,
    scope = threadLifecycle.current,
  ) => {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setWorking(true);
    setError("");
    let success = false;
    try {
      await action(scope.signal);
      success = !scope.signal.aborted;
    } catch (e) {
      if (!scope.signal.aborted) {
        setError(
          explain(e) +
            (!(e instanceof ApiError)
              ? " The request may have been accepted. Check history before retrying."
              : ""),
        );
        void refreshThread.current();
      }
    } finally {
      actionInFlight.current = false;
      if (!scope.signal.aborted) setWorking(false);
    }
    return success;
  };
  return {
    threads: titledThreads,
    threadId,
    history,
    pending,
    activity,
    stream,
    loading,
    working,
    error,
    catalogueCursor,
    select,
    refreshThreads,
    /** Dismiss the current request error. */
    clearError: () => setError(""),
    /** Open a local draft without creating a server-side conversation. */
    create: () => {
      select(null);
    },
    /** Delete a conversation, clear its title overlay, and refresh the catalogue. */
    remove: (id: string) =>
      perform(async (signal) => {
        if (!api) return;
        await api.remove(id, signal);
        if (signal.aborted) return;
        setTitles((old) => {
          const next = new Map(old);
          next.delete(id);
          return next;
        });
        if (threadId === id) select(null);
        await refreshThreads();
      }, lifecycle.current),
    /** Show the prompt immediately, persist a draft on first send, and reconcile acceptance with live events. */
    send: (message: string) =>
      perform(async (signal) => {
        if (!api) throw new Error("Connection unavailable.");
        const local: Message = { id: `local:${crypto.randomUUID()}`, role: "user", text: message };
        optimistic.current = {
          message: local,
          previousIds: new Set(history.messages.map((item) => item.id)),
        };
        setHistory((old) => ({ ...old, messages: [...old.messages, local] }));
        let runId: string;
        let targetId = threadId;
        try {
          if (!targetId) targetId = (await api.create(signal)).id;
          if (signal.aborted) return;
          ({ runId } = await api.send(targetId, message, signal));
        } catch (error) {
          // A transport failure may follow acceptance; retain the prompt until history resolves it.
          if (
            !signal.aborted &&
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            optimistic.current = null;
            setHistory((old) => ({
              ...old,
              messages: old.messages.filter((item) => item.id !== local.id),
            }));
          }
          throw error;
        } finally {
          if (!threadId && targetId && !signal.aborted) {
            // Subscribe after acceptance; durable events replay the first run.
            // Preserve its local prompt while switching from the draft to saved history.
            createdThread.current = targetId;
            setThreadId(targetId);
            saveThread(targetId);
            void refreshThreads();
          }
        }
        if (signal.aborted) return;
        if (!seenRuns.current.has(runId))
          setActivity((old) => ({ ...old, runId, phase: "running" }));
        void refreshThread.current();
      }),
    /** Submit approval decisions without overwriting events that arrived before acceptance. */
    resume: async (answers: Record<string, boolean>) => {
      await perform(async (signal) => {
        if (!api || !threadId) return;
        const { runId } = await api.resume(threadId, answers, signal);
        if (signal.aborted) return;
        if (!seenRuns.current.has(runId)) {
          setPending([]);
          setActivity((old) => ({ ...old, runId, phase: "running" }));
        }
      });
    },
    /** Prepend an older history page without duplicating saved message IDs. */
    older: () =>
      perform(async (signal) => {
        if (!api || !threadId || !history.nextCursor) return;
        const page = await api.snapshot(threadId, signal, history.nextCursor);
        if (!signal.aborted) {
          setActivity((old) => prependActivity(old, page.activity.events));
          setHistory((old) => ({
            messages: [
              ...new Map([...page.messages, ...old.messages].map((m) => [m.id, m])).values(),
            ],
            nextCursor: page.nextCursor,
          }));
        }
      }),
  };
}
export type Wingman = ReturnType<typeof useWingman>;
