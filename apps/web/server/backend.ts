import type { IncomingMessage, ServerResponse } from 'node:http';

export function backendConfig(env: Record<string, string | undefined>) {
  const url = new URL(env.WINGMAN_API_URL || `http://127.0.0.1:${env.PORT || '3000'}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('WINGMAN_API_URL must be an HTTP(S) address without credentials, query or fragment.');
  }
  return { url: url.href.replace(/\/$/, ''), token: env.WINGMAN_API_TOKEN?.trim() ?? '' };
}

/** Protect the token-injecting proxy from cross-origin browser requests. */
export function apiGuard(config: ReturnType<typeof backendConfig>) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = request.url ?? '';
    if (!/^\/api(?:\/|$)/.test(path)) { next(); return; }
    const fail = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message }));
    };
    if (!/^\/api\/threads(?:\/[\w-]{1,64}(?:\/(?:messages|pending|resume|events))?)?\/?$/.test(path.split('?')[0])) { fail(404, 'API route not found.'); return; }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const source = new URL(origin);
        if (!['http:', 'https:'].includes(source.protocol) || source.host !== request.headers.host) {
          fail(403, 'Cross-origin API requests are not allowed.'); return;
        }
      } catch { fail(403, 'Invalid request origin.'); return; }
    }
    if (!config.token) { fail(503, 'Set WINGMAN_API_TOKEN in the environment and restart the web server.'); return; }
    next();
  };
}
