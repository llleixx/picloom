import { test, expect } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";

test("production HTTP serves slow originals and transforms beyond Bun's default idle timeout", async () => {
  const f = await fixture();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch() {
      await Bun.sleep(15_000);
      return new Response(new Uint8Array(f.png), {
        headers: { "content-type": "image/png" },
      });
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const uploaded = await (await f.upload()).json();
    const source = await f.app.plugins.save({
      pluginId: "builtin.webdav",
      version: "1.0.0",
      name: "Slow test storage",
      config: { endpoint: upstream.url.href },
      secretEdits: {
        "/username": { action: "replace", value: "test" },
        "/password": { action: "replace", value: "test" },
      },
    });
    await f.app.db.transaction(async (r) => {
      const replica = (await r.replicas(uploaded.id))[0]!;
      await r.saveReplica({ ...replica, storage_instance_id: source.id });
    });
    await f.app.close();
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port;
    await probe.stop(true);
    const serverProcess = Bun.spawn([process.execPath, "src/main.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...Bun.env,
        DATA_DIR: f.root,
        ENCRYPTION_KEY: f.overrides.encryptionKey,
        DATABASE_URL: "",
        PUBLIC_ORIGIN: "",
        IMAGE_ORIGIN: "",
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = serverProcess;
    const stderr = new Response(serverProcess.stderr).text();
    const reader = serverProcess.stdout.getReader();
    const timer = setTimeout(() => serverProcess.kill("SIGKILL"), 10_000);
    let origin = "";
    try {
      let output = "";
      const decoder = new TextDecoder();
      while (!origin) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error("Production server did not start: " + (await stderr));
        output += decoder.decode(value, { stream: true });
        for (const line of output.split("\n").slice(0, -1)) {
          const event = JSON.parse(line);
          if (event.event === "listening") origin = event.url;
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const path = new URL(uploaded.url).pathname;
    const [original, transformed] = await Promise.all(
      [path, path + "?w=8&format=webp"].map(async (path) => {
        const response = await fetch(new URL(path, origin), {
          signal: AbortSignal.timeout(25_000),
        });
        expect(response.status).toBe(200);
        return {
          response,
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      }),
    );
    expect(original!.bytes).toEqual(new Uint8Array(f.png));
    expect(transformed!.response.headers.get("content-type")).toBe(
      "image/webp",
    );
    expect((await sharp(transformed!.bytes).metadata()).width).toBe(8);
    serverProcess.kill("SIGTERM");
    expect(await serverProcess.exited).toBe(0);
    expect(await stderr).not.toContain("timed out a request");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await upstream.stop(true);
    await f.close();
  }
}, 40_000);
