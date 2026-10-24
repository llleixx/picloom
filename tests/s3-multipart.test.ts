import { test, expect } from "bun:test";
import { fixture } from "./helpers";

test("S3 multipart batches, conditional completion, retries and abort cleanup", async () => {
  const f = await fixture();
  const sessions = new Map<
    string,
    { parts: Map<number, Uint8Array>; headers: Headers }
  >();
  const objects = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  let mode = "ok",
    active = 0,
    peak = 0,
    aborts = 0,
    puts = 0;
  let cancellation = new AbortController();
  const xml = (text: string, status = 200) =>
    new Response(text, {
      status,
      headers: { "content-type": "application/xml" },
    });
  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: 20 * 1024 ** 2,
    async fetch(req) {
      const url = new URL(req.url),
        id = url.searchParams.get("uploadId")!;
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = crypto.randomUUID();
        sessions.set(id, { parts: new Map(), headers: req.headers });
        return xml(
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (req.method === "PUT" && id) {
        active++;
        peak = Math.max(peak, active);
        const n = Number(url.searchParams.get("partNumber"));
        const body = new Uint8Array(await req.arrayBuffer());
        await Bun.sleep(n === 1 ? 30 : 10);
        active--;
        if (mode === "cancel") cancellation.abort();
        if (mode === "fail" && n === 2)
          return xml("<Error><Code>InternalError</Code></Error>", 500);
        sessions.get(id)?.parts.set(n, body);
        return new Response(null, { headers: { etag: `"part-${n}"` } });
      }
      if (req.method === "DELETE" && id) {
        if (mode !== "cancel") expect(active).toBe(0);
        aborts++;
        sessions.delete(id);
        return new Response(null, { status: 204 });
      }
      if (req.method === "POST" && id) {
        expect(req.headers.get("if-none-match")).toBe("*");
        const body = await req.text();
        expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(
          body.indexOf("<PartNumber>2</PartNumber>"),
        );
        if (objects.has(url.pathname))
          return xml("<Error><Code>PreconditionFailed</Code></Error>", 412);
        const session = sessions.get(id)!;
        const bytes = Buffer.concat(
          [...session.parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, b]) => b),
        );
        objects.set(url.pathname, { bytes, headers: session.headers });
        sessions.delete(id);
        if (mode === "lost")
          return xml("<Error><Code>InternalError</Code></Error>", 500);
        return xml(
          '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
        );
      }
      if (req.method === "HEAD") {
        const o = objects.get(url.pathname);
        if (!o) return new Response(null, { status: 404 });
        return new Response(null, {
          headers: {
            "content-length": String(o.bytes.length),
            "x-amz-meta-operation": o.headers.get("x-amz-meta-operation")!,
            "x-amz-meta-file": o.headers.get("x-amz-meta-file")!,
          },
        });
      }
      if (req.method === "PUT") {
        puts++;
        await req.arrayBuffer();
        return new Response(null);
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const record = await f.app.plugins.save({
      pluginId: "builtin.s3",
      version: "1.0.0",
      name: "Multipart",
      config: {
        keyPrefix: "",
        forcePathStyle: true,
        readMode: "proxy",
        signedUrlSeconds: 300,
        endpoint: server.url.origin,
        region: "test",
        bucket: "test",
        multipartThresholdMiB: 5,
        partSizeMiB: 5,
        partConcurrency: 2,
      },
      secretEdits: {
        "/accessKeyId": { action: "replace", value: "key" },
        "/secretAccessKey": { action: "replace", value: "secret" },
      },
    });
    await expect(
      f.app.plugins.save({
        pluginId: "builtin.s3",
        version: "1.0.0",
        name: "Invalid",
        config: {
          multipartThresholdMiB: 64,
          partConcurrency: 3,
          keyPrefix: "",
          forcePathStyle: true,
          readMode: "proxy",
          signedUrlSeconds: 300,
          ...record.config_json,
          partSizeMiB: 4,
        },
        secretEdits: {
          "/accessKeyId": { action: "replace", value: "key" },
          "/secretAccessKey": { action: "replace", value: "secret" },
        },
      }),
    ).rejects.toThrow();
    const lease = f.app.plugins.acquire(record.id, "storage");
    try {
      const bytes = Buffer.alloc(11 * 1024 ** 2, 42);
      const file = {
        metadata: {
          mimeType: "image/png",
          byteSize: bytes.length,
          width: null,
          height: null,
        },
        async openRead() {
          return new Blob([bytes]).stream();
        },
      };
      const ctx = {
        signal: AbortSignal.timeout(15000),
        requestId: "test",
        log() {},
      };
      const input = {
        operationId: "op",
        fileId: "file",
        storageKey: "large",
        file,
      };
      expect(await lease.runtime.write(input, ctx)).toEqual({
        locator: { key: "large" },
      });
      expect(objects.get("/test/large")!.bytes).toEqual(bytes);
      expect(peak).toBe(2);
      expect(sessions.size).toBe(0);
      expect(puts).toBe(0);
      expect(await lease.runtime.write(input, ctx)).toEqual({
        locator: { key: "large" },
      }); // A repeat of the same operation succeeds after 412.
      await expect(
        lease.runtime.write({ ...input, operationId: "other" }, ctx),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      mode = "lost";
      await expect(
        lease.runtime.write({ ...input, storageKey: "lost" }, ctx),
      ).rejects.toMatchObject({ retryable: true });
      await expect(
        lease.runtime.write({ ...input, storageKey: "lost" }, ctx),
      ).resolves.toEqual({ locator: { key: "lost" } });
      mode = "fail";
      await expect(
        lease.runtime.write({ ...input, storageKey: "fail" }, ctx),
      ).rejects.toMatchObject({ retryable: true });
      expect(objects.has("/test/fail")).toBe(false);
      expect(sessions.size).toBe(0);
      await expect(
        lease.runtime.write(
          {
            ...input,
            storageKey: "invalid",
            file: {
              ...file,
              async openRead() {
                return new Blob([new Uint8Array([1])]).stream();
              },
            },
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "INVALID_DATA", retryable: false });
      expect(sessions.size).toBe(0);
      mode = "cancel";
      await expect(
        lease.runtime.write(
          { ...input, storageKey: "cancel" },
          { ...ctx, signal: cancellation.signal },
        ),
      ).rejects.toThrow();
      expect(sessions.size).toBe(0);
      expect(aborts).toBe(7);
      mode = "ok";
      await lease.runtime.write(
        {
          ...input,
          file: {
            ...file,
            metadata: { ...file.metadata, byteSize: 1 },
            async openRead() {
              return new Blob([new Uint8Array([1])]).stream();
            },
          },
        },
        ctx,
      );
      expect(puts).toBe(1);
    } finally {
      await lease.release();
    }
  } finally {
    await server.stop(true);
    await f.close();
  }
});
