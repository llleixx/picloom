import { startRuntime } from "../src/runtime";
import { initializeDevelopment } from "../src/bootstrap";
import { maxUploadBodyBytes } from "../shared/runtime-settings";
const runtime = await startRuntime(
  {
    root: process.env.E2E_ROOT!,
    encryptionKey: "cd".repeat(32),
    origin: "http://127.0.0.1",
    secureCookie: false,
  },
  { initialPassword: "test-password-123" },
);
await initializeDevelopment(runtime.app);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.E2E_PORT ?? 0),
  maxRequestBodySize: maxUploadBodyBytes,
  fetch: (req) => runtime.fetch(req),
});
await runtime.app.delivery.save({
  ...runtime.app.delivery.get(),
  publicOrigin: server.url.origin,
});
console.log(JSON.stringify({ ready: server.url.origin }));
for await (const _ of Bun.stdin.stream()) break;
await server.stop(true);
await runtime.close();
