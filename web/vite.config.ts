import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const target = env.BACKEND_URL ?? "http://127.0.0.1:3000";
  return {
    root: resolve("web"),
    base: "/",
    plugins: [vue(), tailwindcss()],
    resolve: { alias: { "@": resolve("web/src") } },
    build: { outDir: resolve("dist/web"), emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "^/(?!$|app(?:/|$)|login(?:/|$)|assets(?:/|$)|@|src/|node_modules/)": {
          target,
          changeOrigin: false,
        },
      },
    },
  };
});
