import { isIP } from "node:net";
import { maxUploadBodyBytes } from "../shared/runtime-settings";
import { startRuntime } from "./runtime";
const runtime = await startRuntime({ port: Number(process.env.PORT ?? 3000) });
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: runtime.app.config.port,
  maxRequestBodySize: maxUploadBodyBytes,
  fetch(req, server) {
    // Backups are bounded by archive size but may take longer than the default idle timeout.
    if (
      req.method === "POST" &&
      new URL(req.url).pathname.startsWith("/api/system/backups")
    )
      server.timeout(req, 0);
    const peer = server.requestIP(req)?.address ?? "unknown";
    // A trusted proxy must replace X-Real-IP, not append untrusted client input.
    const forwarded = runtime.app.config.trustedProxies.includes(peer)
      ? req.headers.get("x-real-ip")
      : null;
    return runtime.fetch(req, forwarded && isIP(forwarded) ? forwarded : peer);
  },
});
console.info(JSON.stringify({ event: "listening", url: server.url.href }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await runtime.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
