import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { PluginError } from "../src/plugins/api";
test("S3 SDK protocol enforces conditional creation, repeated writes, streams and signed redirect", async () => {
  const objects = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  let requests = 0,
    loseResponse = false,
    failureStatus = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests++;
      const url = new URL(req.url),
        key = url.pathname;
      if (req.method === "GET" && url.searchParams.get("list-type") === "2")
        return new Response(
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>' +
            [...objects.entries()]
              .map(
                ([key, value]) =>
                  "<Contents><Key>" +
                  decodeURIComponent(key.slice("/test/".length)) +
                  "</Key><Size>" +
                  value.bytes.length +
                  "</Size></Contents>",
              )
              .join("") +
            "</ListBucketResult>",
        );
      if (failureStatus) {
        await req.arrayBuffer();
        return new Response("<Error><Code>InjectedFailure</Code></Error>", {
          status: failureStatus,
        });
      }
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
        multipartThresholdMiB: 64,
        partSizeMiB: 16,
        partConcurrency: 3,
        keyPrefix: "prefix",
        forcePathStyle: true,
        signedUrlSeconds: 300,
        endpoint: server.url.origin,
        region: "test",
        bucket: "test",

        readMode: "signed",
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
      expect(result.locator).toEqual({ key: "prefix/中文/a.png" });
      expect(objects.has("/test/prefix/%E4%B8%AD%E6%96%87/a.png")).toBe(true);
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
      const before = requests;
      await expect(
        lease.runtime.delete(
          {
            operationId: "missing-locator",
            storageKey: "中文/a.png",
            locator: null,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
      expect(requests).toBe(before);
      expect(objects.has("/test/prefix/%E4%B8%AD%E6%96%87/a.png")).toBe(true);
      const listed = await lease.runtime.listFiles!({ limit: 10 }, ctx);
      expect(listed.items).toEqual([
        {
          storageKey: "中文/a.png",
          locator: { key: "prefix/中文/a.png" },
          byteSize: f.png.length,
        },
      ]);
      await lease.runtime.delete(
        {
          operationId: "delete",
          storageKey: "中文/a.png",
          locator: listed.items[0]!.locator!,
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
      ).rejects.toMatchObject({ retryable: true });
      expect(
        await lease.runtime.write(
          {
            operationId: "lost-response",
            fileId: another,
            storageKey: "x",
            file,
          },
          ctx,
        ),
      ).toEqual({ locator: { key: "prefix/x" } });
      for (const status of [401, 403, 408, 409, 429, 503]) {
        failureStatus = status;
        const retryable = [408, 429, 503].includes(status);
        await expect(
          lease.runtime.write(
            { operationId: "classify", fileId, storageKey: "errors", file },
            ctx,
          ),
        ).rejects.toMatchObject({ retryable: status === 409 || retryable });
        await expect(
          lease.runtime.delete(
            {
              operationId: "classify-delete",
              storageKey: "x",
              locator: { key: "prefix/x" },
            },
            ctx,
          ),
        ).rejects.toMatchObject({ retryable });
      }
      failureStatus = 404;
      await expect(
        lease.runtime.delete(
          {
            operationId: "already-missing",
            storageKey: "missing",
            locator: { key: "prefix/missing" },
          },
          ctx,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await lease.release();
    }
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("S3 public redirects preserve object paths and stream reads use the API in every mode", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return new Response("image", {
        headers: { "content-type": "image/png" },
      });
    },
  });
  const f = await fixture();
  const config = {
    endpoint: server.url.origin,
    region: "test",
    bucket: "bucket",
    keyPrefix: "photos",
    forcePathStyle: true,
    multipartThresholdMiB: 64,
    partSizeMiB: 16,
    partConcurrency: 3,
  };
  const save = (options: Record<string, unknown>) =>
    f.app.plugins.save({
      pluginId: "builtin.s3",
      version: "1.0.0",
      name: "Read modes",
      config: { ...config, ...options },
      secretEdits: {
        "/accessKeyId": { action: "replace", value: "test" },
        "/secretAccessKey": { action: "replace", value: "test" },
      },
    });
  const ctx = {
    signal: new AbortController().signal,
    requestId: "read",
    log() {},
  };
  try {
    for (const options of [
      { readMode: "public" },
      { readMode: "signed" },
      ...[
        "ftp://example.com/",
        "https://user:pass@example.com/",
        "https://example.com/?a=1",
        "https://example.com/#part",
      ].map((publicBaseUrl) => ({ readMode: "public", publicBaseUrl })),
    ])
      await expect(save(options)).rejects.toBeDefined();

    for (const readMode of ["proxy", "signed", "public"]) {
      const record = await save({
        readMode,
        signedUrlSeconds: 60,
        publicBaseUrl: "https://img.example.com/assets",
      });
      const lease = f.app.plugins.acquire(record.id, "storage");
      try {
        const input = {
          storageKey: "a.png",
          locator: { key: "photos/中文/a #%.png" },
        };
        const result = await lease.runtime.read(
          { ...input, mode: "auto" },
          ctx,
        );
        if (readMode === "proxy") {
          expect(result.type).toBe("stream");
          if (result.type === "stream")
            expect(await new Response(result.stream).text()).toBe("image");
        } else if (readMode === "signed") {
          expect(result.type).toBe("redirect");
          if (result.type === "redirect") {
            expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe(
              "60",
            );
            expect(result.expiresAt).toBeGreaterThan(Date.now());
          }
        } else {
          expect(result).toEqual({
            type: "redirect",
            url: "https://img.example.com/assets/photos/%E4%B8%AD%E6%96%87/a%20%23%25.png",
          });
          expect(
            await lease.runtime.read(
              { ...input, locator: { key: "imported/a.png" }, mode: "auto" },
              ctx,
            ),
          ).toEqual({
            type: "redirect",
            url: "https://img.example.com/assets/imported/a.png",
          });
        }
        const streamed = await lease.runtime.read(
          { ...input, mode: "stream" },
          ctx,
        );
        expect(streamed.type).toBe("stream");
        if (streamed.type === "stream")
          expect(await new Response(streamed.stream).text()).toBe("image");
      } finally {
        await lease.release();
      }
    }
    expect(paths).toEqual(
      Array(4).fill("/bucket/photos/%E4%B8%AD%E6%96%87/a%20%23%25.png"),
    );
    const record = await save({
      readMode: "public",
      publicBaseUrl: "https://img.example.com/assets/",
    });
    const lease = f.app.plugins.acquire(record.id, "storage");
    try {
      expect(
        await lease.runtime.read(
          { storageKey: "a.png", locator: null, mode: "auto" },
          ctx,
        ),
      ).toEqual({
        type: "redirect",
        url: "https://img.example.com/assets/photos/a.png",
      });
    } finally {
      await lease.release();
    }
  } finally {
    await server.stop(true);
    await f.close();
  }
});
