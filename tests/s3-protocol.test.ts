import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { PluginError } from "../src/plugins/api";
test("S3 SDK protocol enforces conditional creation, metadata recovery, streams and signed redirect", async () => {
  const objects = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  let loseResponse = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const key = new URL(req.url).pathname;
      if (req.method === "PUT") {
        expect(req.headers.get("if-none-match")).toBe("*");
        expect(req.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
        if (objects.has(key))
          return new Response(
            "<Error><Code>PreconditionFailed</Code></Error>",
            { status: 412, headers: { "content-type": "application/xml" } },
          );
        objects.set(key, {
          bytes: new Uint8Array(await req.arrayBuffer()),
          headers: req.headers,
        });
        return loseResponse
          ? new Response("<Error><Code>InternalError</Code></Error>", {
              status: 500,
            })
          : new Response(null, { status: 200 });
      }
      const item = objects.get(key);
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!item) return new Response(null, { status: 404 });
      const headers = new Headers({
        "content-length": String(item.bytes.length),
        "content-type": "image/png",
        "x-amz-meta-operation": item.headers.get("x-amz-meta-operation")!,
        "x-amz-meta-file": item.headers.get("x-amz-meta-file")!,
      });
      return new Response(
        req.method === "HEAD" ? null : new Uint8Array(item.bytes),
        { headers },
      );
    },
  });
  const f = await fixture();
  try {
    const record = await f.app.plugins.save({
      secretEdits: {
        "/accessKeyId": { action: "replace", value: "test-key" },
        "/secretAccessKey": { action: "replace", value: "test-secret" },
      },
      pluginId: "builtin.s3",
      version: "1.0.0",
      name: "S3 protocol fixture",
      config: {
        endpoint: server.url.origin,
        region: "test",
        bucket: "test",

        redirect: true,
      },
    });
    expect(record.config_json.multipartThresholdMiB).toBe(64);
    expect(record.config_json.partSizeMiB).toBe(16);
    expect(record.config_json.partConcurrency).toBe(3);
    const lease = f.app.plugins.acquire(record.id, "storage"),
      ctx = {
        signal: new AbortController().signal,
        requestId: "test",
        log() {},
      },
      file = {
        metadata: {
          mimeType: "image/png",
          byteSize: f.png.length,
          width: 40,
          height: 20,
        },
        async openRead() {
          return new Blob([new Uint8Array(f.png)]).stream();
        },
      },
      fileId = crypto.randomUUID();
    try {
      const result = await lease.runtime.write(
        { operationId: "write-1", fileId, storageKey: "中文/a.png", file },
        ctx,
      );
      expect(result.locator).toBeNull();
      expect(objects.has("/test/%E4%B8%AD%E6%96%87/a.png")).toBe(true);
      expect(
        (
          await lease.runtime.recoverWrite!(
            {
              operationId: "write-1",
              fileId,
              storageKey: "中文/a.png",
              expectedSize: f.png.length,
              locator: null,
            },
            ctx,
          )
        ).status,
      ).toBe("stored");
      expect(
        await lease.runtime.write(
          { operationId: "write-1", fileId, storageKey: "中文/a.png", file },
          ctx,
        ),
      ).toEqual(result);
      await expect(
        lease.runtime.write(
          { operationId: "different", fileId, storageKey: "中文/a.png", file },
          ctx,
        ),
      ).rejects.toBeInstanceOf(PluginError);
      const stream = await lease.runtime.read(
        { storageKey: "中文/a.png", locator: result.locator!, mode: "stream" },
        ctx,
      );
      expect(stream.type).toBe("stream");
      if (stream.type === "stream")
        expect(
          new Uint8Array(await new Response(stream.stream).arrayBuffer()),
        ).toEqual(new Uint8Array(f.png));
      const redirect = await lease.runtime.read(
        { storageKey: "中文/a.png", locator: result.locator!, mode: "auto" },
        ctx,
      );
      expect(redirect.type).toBe("redirect");
      if (redirect.type === "redirect")
        expect(redirect.url).toContain("X-Amz-Signature");
      await lease.runtime.delete(
        {
          operationId: "delete",
          storageKey: "中文/a.png",
          locator: result.locator!,
        },
        ctx,
      );
      await lease.runtime.delete(
        {
          operationId: "delete",
          storageKey: "中文/a.png",
          locator: result.locator!,
        },
        ctx,
      );
      expect(
        (
          await lease.runtime.recoverWrite!(
            {
              operationId: "write-1",
              fileId,
              storageKey: "中文/a.png",
              expectedSize: f.png.length,
              locator: null,
            },
            ctx,
          )
        ).status,
      ).toBe("notStored");
      loseResponse = true;
      const another = crypto.randomUUID();
      await expect(
        lease.runtime.write(
          {
            operationId: "lost-response",
            fileId: another,
            storageKey: "x",
            file,
          },
          ctx,
        ),
      ).rejects.toBeInstanceOf(PluginError);
      expect(
        (
          await lease.runtime.recoverWrite!(
            {
              operationId: "lost-response",
              fileId: another,
              storageKey: "x",
              expectedSize: f.png.length,
              locator: null,
            },
            ctx,
          )
        ).status,
      ).toBe("stored");
    } finally {
      await lease.release();
    }
  } finally {
    await server.stop(true);
    await f.close();
  }
});
