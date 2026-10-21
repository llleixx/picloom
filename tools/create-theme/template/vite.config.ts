import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/package",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: resolve("src/entry.ts"),
      formats: ["es"],
      fileName: () => "entry.js",
      cssFileName: "style",
    },
  },
});
