import { pipelineData } from "../src/core/pipeline-data";
import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { PluginError } from "../src/plugins/api";
test("Webhook does not read bytes, sends authenticated metadata, refuses redirects and retries timeouts", async () => {
  const f = await fixture();
  let mode = "ok",
    redirectCalls = 0,
    header = "",
    body: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/redirect") {
        redirectCalls++;
        return new Response(null, { status: 204 });
      }
      header = req.headers.get("authorization") ?? "";
      body = await req.json();
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/redirect" },
        });
      if (mode === "timeout") {
        await Bun.sleep(500);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    },
  });
  try {
    const instance = await f.app.plugins.save({
        secretEdits: { "/token": { action: "replace", value: "secret" } },
        pluginId: "builtin.webhook",
        stage: "post_save",
        version: "1.0.0",
        name: "hook",
        config: { url: server.url.href, timeoutMs: 100 },
      }),
      lease = f.app.plugins.acquire(instance.id, "post_save");
    const input = {
        operationId: "stable-task",
        fileId: "file",
        publicPath: "/i/a.png",
        url: "http://localhost/i/a.png",
        file: {
          metadata: {
            mimeType: "image/png",
            byteSize: 123,
            width: 2,
            height: 3,
          },
          async openRead() {
            throw new Error("must not read image");
          },
        },
      },
      ctx = {
        signal: new AbortController().signal,
        data: pipelineData(),
        requestId: "test",
        log() {},
      };
    try {
      await lease.runtime.execute(input, ctx);
      expect(header).toBe("Bearer secret");
      expect(body.operationId).toBe("stable-task");
      expect(redirectCalls).toBe(0);
      mode = "redirect";
      try {
        await lease.runtime.execute(input, ctx);
        throw Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(PluginError);
        expect((e as PluginError).retryable).toBe(false);
      }
      expect(redirectCalls).toBe(0);
      mode = "timeout";
      try {
        await lease.runtime.execute(input, ctx);
        throw Error("expected timeout");
      } catch (e) {
        expect(e).toBeInstanceOf(PluginError);
        expect((e as PluginError).retryable).toBe(true);
      }
    } finally {
      await lease.release();
    }
  } finally {
    await server.stop(true);
    await f.close();
  }
});
