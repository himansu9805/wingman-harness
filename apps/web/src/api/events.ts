import { ApiError } from './client';
import type { Connection, ThreadEvent } from './types';

export interface EventFrame { id: string; event: string; data: string }

/** Incremental SSE parser: chunk boundaries may split lines, CRLF or UTF-8 text. */
export class EventParser {
  private buffer = '';
  private data: string[] = [];
  private id = '';
  private event = '';
  private size = 0;
  constructor(private readonly emit: (frame: EventFrame) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) throw new Error('Event exceeded the size limit.');
    let end: number;
    while ((end = this.buffer.search(/[\r\n]/)) >= 0) {
      if (this.buffer[end] === '\r' && end === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, end);
      const length = this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(end + length);
      if (!line) {
        if (this.data.length) this.emit({ id: this.id, event: this.event || 'message', data: this.data.join('\n') });
        this.data = []; this.event = ''; this.size = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') { this.data.push(value); this.size += value.length; }
        if (field === 'event') this.event = value;
        if (field === 'id' && !value.includes('\0')) this.id = value;
      }
      if (this.size > 1_000_000) throw new Error('Event exceeded the size limit.');
    }
  }
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
interface WatchOptions {
  connection: Connection; threadId: string; signal: AbortSignal;
  onEvent: (event: ThreadEvent, id: string) => void;
  onStatus: (status: StreamStatus) => void;
  onError: (error: Error) => void;
  fetcher?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Retries only the read subscription. Commands are never automatically resubmitted. */
export async function watchEvents(options: WatchOptions): Promise<void> {
  const { connection, threadId, signal, onEvent, onStatus, onError } = options;
  let cursor = ''; let retry = 1_000;
  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      onStatus(cursor ? 'reconnecting' : 'connecting');
      const response = await (options.fetcher ?? fetch)(`${connection.url}/threads/${encodeURIComponent(threadId)}/events`, {
        headers: cursor ? { 'Last-Event-ID': cursor } : {}, credentials: 'same-origin', signal,
      });
      if (!response.ok) throw new ApiError(response.status, `Event connection failed (${response.status}).`);
      if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Server did not return an event stream.');
      reader = response.body.getReader();
      onStatus('live'); retry = 1_000;
      const decoder = new TextDecoder();
      const parser = new EventParser(frame => {
        if (!frame.id.startsWith(`${threadId}:`)) throw new Error('Event belongs to another thread.');
        const sequence = frame.id.slice(threadId.length + 1);
        if (!/^[1-9]\d{0,18}$/.test(sequence)) throw new Error('Invalid event ID.');
        if (cursor && BigInt(sequence) <= BigInt(cursor.slice(threadId.length + 1))) return;
        const payload = JSON.parse(frame.data) as ThreadEvent;
        if (payload.type !== frame.event || typeof payload.runId !== 'string') throw new Error('Invalid event payload.');
        onEvent(payload, frame.id);
        cursor = frame.id;
      });
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Event connection closed.');
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) {
        onStatus('offline'); onError(error); return;
      }
      onStatus('reconnecting');
    } finally { await reader?.cancel().catch(() => {}); }
    try { await (options.wait ?? wait)(retry, signal); } catch { return; }
    retry = Math.min(retry * 2, 15_000);
  }
}
