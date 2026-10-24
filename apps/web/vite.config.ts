import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { apiGuard, backendConfig } from './server/backend.ts';

export default defineConfig(({ mode }) => {
  const webRoot = fileURLToPath(new URL('.', import.meta.url));
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env = { ...loadEnv(mode, repositoryRoot, ''), ...loadEnv(mode, webRoot, ''), ...process.env };
  const backend = backendConfig(env);
  const guard = apiGuard(backend);
  const proxy: Record<string, ProxyOptions> = {
    '/api/threads': {
      target: backend.url,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
      headers: { Authorization: `Bearer ${backend.token}` },
      // A persistent event subscription must outlive an ordinary HTTP request.
      timeout: 0,
      proxyTimeout: 0,
      configure(proxy) {
        proxy.on('proxyRes', (upstream, _request, response) => {
          if (upstream.headers['content-type']?.startsWith('text/event-stream')) {
            // Forward an idle stream's headers immediately, before the first
            // event/heartbeat. Otherwise a new chat appears stuck connecting.
            queueMicrotask(() => { if (!response.destroyed && !response.headersSent) response.flushHeaders(); });
          }
        });
      },
    },
  };
  return {
    plugins: [stylex.vite({ runtimeInjection: false }), react(), {
      name: 'wingman-private-api',
      configureServer(server) { server.middlewares.use(guard); },
      configurePreviewServer(server) { server.middlewares.use(guard); },
    }],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', proxy },
  };
});
