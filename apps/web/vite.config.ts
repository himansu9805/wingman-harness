import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { apiGuard, backendConfig, isAllowedWebSocketOrigin } from "./server/backend.ts";

export default defineConfig(({ mode }) => {
  const webRoot = fileURLToPath(new URL(".", import.meta.url));
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const env = {
    ...loadEnv(mode, repositoryRoot, ""),
    ...loadEnv(mode, webRoot, ""),
    ...process.env,
  };
  const backend = backendConfig(env);
  const guard = apiGuard(backend);
  const websocketProxy: ProxyOptions = {
    target: backend.url,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
    headers: { Authorization: `Bearer ${backend.token}` },
    configure(proxy) {
      proxy.on("proxyReqWs", (upstream, request, socket) => {
        if (!backend.token || !isAllowedWebSocketOrigin(request)) {
          upstream.destroy();
          socket.destroy();
          return;
        }
        upstream.setHeader("Origin", env.WEB_ORIGIN ?? "http://localhost:5173");
      });
    },
  };
  const proxy: Record<string, ProxyOptions> = {
    "^/api/sandboxes/[\\w-]{1,64}/output/ws(?:\\?|$)": websocketProxy,
    "^/api/threads/[\\w-]{1,64}/events/ws(?:\\?|$)": websocketProxy,
    "^/api/(threads|tasks|sandboxes)(/|\\?|$)": {
      target: backend.url,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ""),
      headers: { Authorization: `Bearer ${backend.token}` },
    },
  };
  return {
    plugins: [
      stylex.vite({ runtimeInjection: false }),
      react(),
      {
        name: "wingman-private-api",
        configureServer(server) {
          server.middlewares.use(guard);
        },
        configurePreviewServer(server) {
          server.middlewares.use(guard);
        },
      },
    ],
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
    preview: { host: "127.0.0.1", proxy },
  };
});
