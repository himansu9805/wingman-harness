import type { Approval, Catalogue, Connection, History } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const defaultConnection: Connection = { url: '/api' };

export function createApi(connection: Connection = defaultConnection, fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, signal: AbortSignal, body?: unknown, method?: string): Promise<T> {
    const response = await fetcher(`${connection.url}/threads${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const message = typeof data?.message === 'string' ? data.message : `Request failed (${response.status}).`;
      throw new ApiError(response.status, message);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  const idPath = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    connection,
    list: (signal: AbortSignal, cursor?: string) => request<Catalogue>(`?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal),
    create: (signal: AbortSignal) => request<{ id: string }>('', signal, {}),
    remove: (id: string, signal: AbortSignal) => request<void>(idPath(id), signal, undefined, 'DELETE'),
    history: (id: string, signal: AbortSignal, cursor?: string) => request<History>(`${idPath(id)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal),
    pending: (id: string, signal: AbortSignal) => request<Approval[]>(`${idPath(id)}/pending`, signal),
    send: (id: string, message: string, signal: AbortSignal) => request<{ runId: string }>(`${idPath(id)}/messages`, signal, { message }),
    resume: (id: string, answers: Record<string, boolean>, signal: AbortSignal) => request<{ runId: string }>(`${idPath(id)}/resume`, signal, { answers }),
  };
}
export type Api = ReturnType<typeof createApi>;
