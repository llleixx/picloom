import { createClientIpResolver } from "./trusted-proxies";
import { maxUploadBodyBytes } from "../shared/runtime-settings";
import { startRuntime } from "./runtime";
const runtime = await startRuntime({ port: Number(process.env.PORT ?? 3000) });
const clientIp = createClientIpResolver(runtime.app.config.trustedProxies);
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
    return runtime.fetch(req, clientIp(peer, req.headers.get("x-real-ip")));
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
