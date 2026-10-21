import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
export default defineConfig({
  plugins: [vue()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: resolve("outputs/themes/split"),
    emptyOutDir: true,
    lib: {
      entry: resolve("examples/themes/split/entry.ts"),
      formats: ["es"],
      fileName: () => "entry.js",
      cssFileName: "style",
    },
  },
});
