import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const target = env.BACKEND_URL ?? "http://127.0.0.1:7425";
  return {
    root: resolve("web"),
    base: "/",
    plugins: [
      {
        name: "picloom-entry",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (/^\/app(?:\/|\?|$)/.test(req.url ?? ""))
              req.url = "/admin.html";
            next();
          });
        },
      },
      vue(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": resolve("web/src") } },
    build: {
      outDir: resolve("dist/web"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve("web/index.html"),
          admin: resolve("web/admin.html"),
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/assets/themes/": { target, changeOrigin: false },
        "^/(?!$|\\?|(?:admin|index)\\.html(?:\\?|$)|app(?:/|\\?|$)|login(?:/|\\?|$)|assets(?:/|$)|@|src/|node_modules/)":
          {
            target,
            changeOrigin: false,
          },
      },
    },
  };
});
