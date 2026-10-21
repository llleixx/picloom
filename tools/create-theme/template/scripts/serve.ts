import { createServer, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { initialValue } from "../dev/helpers.js";
import { assetPath, readManifest } from "./manifest";
const args = process.argv.slice(2),
  production = args.includes("--preview");
const portIndex = args.indexOf("--port");
const port = portIndex === -1 ? 5173 : Number(args[portIndex + 1]);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  args.some(
    (arg, i) =>
      arg !== "--preview" &&
      arg !== "--port" &&
      !(portIndex >= 0 && i === portIndex + 1),
  )
)
  throw Error(
    "Usage: bun run dev [--port 5173] / bun run preview [--port 5173]",
  );
if (production && !(await Bun.file("dist/package/entry.js").exists()))
  throw Error("No production build. Run bun run build first.");
const manifestPath = production ? "dist/package/theme.json" : "theme.json";
try {
  if (!(await Bun.file("dev/config.json").exists())) {
    const manifest = await readManifest(manifestPath);
    await mkdir("dev", { recursive: true });
    await writeFile(
      "dev/config.json",
      JSON.stringify(
        initialValue(manifest.configSchema ?? { type: "object" }) ?? {},
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST")
    console.error(String(error));
}
const virtual = "virtual:picloom-preview",
  resolved = "\0" + virtual;
const plugin: Plugin = {
  name: "picloom-preview",
  resolveId(id) {
    if (id === virtual) return resolved;
  },
  async load(id) {
    if (id !== resolved) return;
    const manifest = await readManifest(manifestPath);
    const config = JSON.parse(await readFile("dev/config.json", "utf8"));
    if (!config || Array.isArray(config) || typeof config !== "object")
      throw Error("dev/config.json must contain an object");
    return `export const manifest=${JSON.stringify(manifest)};export const config=${JSON.stringify(config)};export const production=${production};`;
  },
  configureServer(server) {
    server.watcher.add([manifestPath, "dev/config.json"]);
    server.watcher.on("all", (_event, path) => {
      if (
        [manifestPath, "dev/config.json"].some(
          (name) => resolve(path) === resolve(name),
        )
      ) {
        const module = server.moduleGraph.getModuleById(resolved);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      }
    });
    server.middlewares.use(async (req, res, next) => {
      try {
        const path = decodeURIComponent(req.url?.split("?")[0] ?? "");
        // Built resources are served verbatim, including encoded names and ?import.
        if (production && assetPath(path.slice(1))) {
          const file = Bun.file(resolve("dist/package", path.slice(1)));
          if (await file.exists()) {
            res.setHeader("Content-Type", file.type);
            res.setHeader("Cache-Control", "no-cache");
            res.end(new Uint8Array(await file.arrayBuffer()));
            return;
          }
        }
        if (path !== "/" && path !== "/login") return next();
        const html = await server.transformIndexHtml(
          req.url!,
          await readFile("dev/index.html", "utf8"),
        );
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      } catch (error) {
        next(error);
      }
    });
  },
};
const server = await createServer({
  configFile: false,
  appType: "mpa",
  plugins: [plugin, vue(), tailwindcss()],
  publicDir: production ? false : "public",
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    // Bun's native filesystem watcher can miss repeated replace/write events.
    watch: { usePolling: true, interval: 150 },
  },
});
await server.listen();
console.log(
  `${production ? "Production build" : "Source HMR"} · SIMULATED uploads and login / 模拟上传与登录`,
);
server.printUrls();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
