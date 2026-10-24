import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createApi } from '../api/client';
import { watchEvents, type StreamStatus } from '../api/events';
import type { Approval, Connection, History, Message, Thread } from '../api/types';
import { applyEvent, emptyActivity } from './events';
import { saveThread, selectedThread } from './storage';

const explain = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
export function useWingman(connection: Connection | null) {
  const api = useMemo(() => connection ? createApi(connection) : null, [connection]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [catalogueCursor, setCatalogueCursor] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(selectedThread);
  const [history, setHistory] = useState<History>({ messages: [], nextCursor: null });
  const [pending, setPending] = useState<Approval[]>([]);
  const [activity, setActivity] = useState(emptyActivity);
  const [stream, setStream] = useState<StreamStatus>('offline');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const lifecycle = useRef(new AbortController());
  const threadLifecycle = useRef(new AbortController());
  const seenRuns = useRef(new Set<string>());
  const refreshThread = useRef<() => Promise<void>>(async () => {});
  const actionInFlight = useRef(false);
  const createdThread = useRef<string | null>(null);
  const optimistic = useRef<{ message: Message; previousIds: Set<string> } | null>(null);

  const select = useCallback((id: string | null) => {
    threadLifecycle.current.abort(); // Reject stale writes immediately, before React runs the next effect.
    setThreadId(id); saveThread(id); setError('');
  }, []);

  const refreshThreads = useCallback(async (more = false) => {
    if (!api) return;
    const signal = lifecycle.current.signal;
    try {
      const page = await api.list(signal, more ? catalogueCursor ?? undefined : undefined);
      if (signal.aborted) return;
      setThreads(old => more ? [...new Map([...old, ...page.threads].map(t => [t.id, t])).values()] : page.threads);
      setCatalogueCursor(page.nextCursor);
    } catch (e) { if (!signal.aborted) setError(explain(e)); }
  }, [api, catalogueCursor]);

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    setThreads([]); setCatalogueCursor(null);
    if (!api) { setThreadId(null); setStream('offline'); return () => controller.abort(); }
    async function poll() {
      try {
        const page = await api!.list(controller.signal);
        if (!controller.signal.aborted) { setThreads(page.threads); setCatalogueCursor(page.nextCursor); }
      } catch (e) { if (!controller.signal.aborted) setError(explain(e)); }
    }
    void poll();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);

  useEffect(() => {
    const controller = new AbortController(); threadLifecycle.current = controller;
    const { signal } = controller;
    const handoff = threadId !== null && createdThread.current === threadId;
    createdThread.current = null;
    if (!handoff) {
      setHistory({ messages: [], nextCursor: null }); setActivity(emptyActivity);
      optimistic.current = null;
    }
    setPending([]);
    setStream('offline'); setLoading(Boolean(api && threadId)); setWorking(false);
    seenRuns.current = new Set();
    if (!api || !threadId) { refreshThread.current = async () => {}; return () => controller.abort(); }
    let refreshing = false; let again = false;
    const refresh = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        do {
          again = false;
          const [messages, approvals] = await Promise.all([api.history(threadId, signal), api.pending(threadId, signal)]);
          if (signal.aborted) return;
          const local = optimistic.current;
          if (local && messages.messages.some(message => message.role === 'user' &&
            message.text === local.message.text && !local.previousIds.has(message.id))) optimistic.current = null;
          setHistory(optimistic.current
            ? { ...messages, messages: [...messages.messages, optimistic.current.message] }
            : messages);
          setPending(approvals);
        } while (again && !signal.aborted);
      } catch (e) {
        if (!signal.aborted) {
          setError(explain(e));
          if (e instanceof ApiError && e.status === 404) select(null);
        }
      } finally { refreshing = false; if (!signal.aborted) setLoading(false); }
    };
    refreshThread.current = refresh;
    void refresh();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void watchEvents({ connection: api.connection, threadId, signal,
      onStatus: status => { if (!signal.aborted) setStream(status); },
      onError: e => { if (!signal.aborted) { setError(explain(e)); if (e instanceof ApiError && e.status === 404) select(null); } },
      onEvent: event => {
        if (signal.aborted) return;
        seenRuns.current.add(event.runId);
        if (seenRuns.current.size > 500) seenRuns.current.delete(seenRuns.current.values().next().value!);
        setActivity(old => applyEvent(old, event));
        if (event.type === 'approval') setPending(event.approvals);
        if (event.type === 'done' || event.type === 'error') setPending([]);
        if (event.type === 'done') setError('');
        if (['done', 'approval', 'error', 'tool_result'].includes(event.type)) {
          clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 75);
        }
        if (event.type === 'error') setError(event.message);
      },
    });
    return () => { controller.abort(); clearTimeout(refreshTimer); };
  }, [api, threadId, select]);

  const perform = async (action: (signal: AbortSignal) => Promise<void>, scope = threadLifecycle.current) => {
    if (actionInFlight.current) return false;
    actionInFlight.current = true; setWorking(true); setError('');
    let success = false;
    try { await action(scope.signal); success = !scope.signal.aborted; }
    catch (e) {
      if (!scope.signal.aborted) {
        setError(explain(e) + (!(e instanceof ApiError) ? ' The request may have been accepted. Check history before retrying.' : ''));
        void refreshThread.current();
      }
    } finally { actionInFlight.current = false; if (!scope.signal.aborted) setWorking(false); }
    return success;
  };
  return {
    threads, threadId, history, pending, activity, stream, loading, working, error,
    catalogueCursor, select, refreshThreads, clearError: () => setError(''),
    create: () => { select(null); },
    remove: (id: string) => perform(async signal => {
      if (!api) return;
      await api.remove(id, signal);
      if (signal.aborted) return;
      if (threadId === id) select(null);
      await refreshThreads();
    }, lifecycle.current),
    send: (message: string) => perform(async signal => {
      if (!api) throw new Error('Connection unavailable.');
      const local: Message = { id: `local:${crypto.randomUUID()}`, role: 'user', text: message };
      optimistic.current = { message: local, previousIds: new Set(history.messages.map(item => item.id)) };
      setHistory(old => ({ ...old, messages: [...old.messages, local] }));
      let runId: string;
      let targetId = threadId;
      try {
        if (!targetId) targetId = (await api.create(signal)).id;
        if (signal.aborted) return;
        ({ runId } = await api.send(targetId, message, signal));
      } catch (error) {
        // A transport failure may follow acceptance; retain the prompt until history resolves it.
        if (!signal.aborted && error instanceof ApiError && error.status >= 400 && error.status < 500) {
          optimistic.current = null;
          setHistory(old => ({ ...old, messages: old.messages.filter(item => item.id !== local.id) }));
        }
        throw error;
      } finally {
        if (!threadId && targetId && !signal.aborted) {
          // Subscribe after acceptance; durable events replay the first run.
          // Preserve its local prompt while switching from the draft to saved history.
          createdThread.current = targetId;
          setThreadId(targetId); saveThread(targetId);
          void refreshThreads();
        }
      }
      if (signal.aborted) return;
      if (!seenRuns.current.has(runId)) setActivity(old => ({ ...old, runId, phase: 'running' }));
      void refreshThread.current();
    }),
    resume: async (answers: Record<string, boolean>) => { await perform(async signal => {
      if (!api || !threadId) return;
      const { runId } = await api.resume(threadId, answers, signal);
      if (signal.aborted) return;
      if (!seenRuns.current.has(runId)) {
        setPending([]);
        setActivity(old => ({ ...old, runId, phase: 'running' }));
      }
    }); },
    older: () => perform(async signal => {
      if (!api || !threadId || !history.nextCursor) return;
      const page = await api.history(threadId, signal, history.nextCursor);
      if (!signal.aborted) setHistory(old => ({ messages: [...new Map([...page.messages, ...old.messages].map(m => [m.id, m])).values()], nextCursor: page.nextCursor }));
    }),
  };
}
export type Wingman = ReturnType<typeof useWingman>;
