import sharp from "sharp";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "bun:test";
import { webdavStorage } from "../src/builtins/webdav";
import {
  PluginError,
  type Config,
  type FileInput,
  type StoragePlugin,
} from "../src/plugins/api";

const context = (signal = new AbortController().signal) => ({
  signal,
  requestId: "webdav-test",
  log() {},
});
const file = (text = "image bytes"): FileInput => ({
  metadata: {
    mimeType: "image/png",
    byteSize: Buffer.byteLength(text),
    width: null,
    height: null,
  },
  async openRead() {
    return new Blob([text]).stream();
  },
});
async function runtime(
  endpoint: string,
  config: Config = {},
): Promise<StoragePlugin> {
  return webdavStorage.createInstance({
    id: "dav-test",
    config: { endpoint, ...config },
    services: {
      images: { sharp },
      log() {},
      async readSecrets() {
        return {
          value: { username: "测试-user", password: "secret:password" },
          version: 1,
        };
      },
      async updateSecrets() {},
      async readState() {
        return { value: {}, version: 1 };
      },
      async updateState() {},
    },
  });
}
function davServer() {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const directories = new Set(["/dav/"]);
  const requests: Array<{ method: string; path: string; headers: Headers }> =
    [];
  const faults = { put: 201, head: 0, mkdir: 0, read: 0, remove: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({ method: req.method, path, headers: req.headers });
      if (
        req.headers.get("authorization") !==
        "Basic " + Buffer.from("测试-user:secret:password").toString("base64")
      )
        return new Response("authentication failed", { status: 401 });
      if (req.method === "MKCOL") {
        if (faults.mkdir)
          return new Response("mkdir failed", { status: faults.mkdir });
        if (directories.has(path) || objects.has(path.slice(0, -1)))
          return new Response("exists", { status: 405 });
        const parent = path
          .slice(0, -1)
          .slice(0, path.slice(0, -1).lastIndexOf("/") + 1);
        if (!directories.has(parent))
          return new Response(null, { status: 409 });
        directories.add(path);
        return new Response(null, { status: 201 });
      }
      if (req.method === "PUT") {
        if (!directories.has(path.slice(0, path.lastIndexOf("/") + 1)))
          return new Response(null, { status: 409 });
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (objects.has(path) && req.headers.get("if-none-match") === "*")
          return new Response(null, { status: 412 });
        objects.set(path, {
          bytes,
          mime: req.headers.get("content-type") ?? "",
        });
        return new Response(null, { status: faults.put });
      }
      if (req.method === "DELETE") {
        if (faults.remove)
          return new Response("delete failed", { status: faults.remove });
        const found = objects.delete(path);
        return new Response(null, { status: found ? 204 : 404 });
      }
      if (req.method === "HEAD" && faults.head)
        return new Response(null, { status: faults.head });
      if (req.method === "GET" && faults.read)
        return new Response("response with secret:password must stay private", {
          status: faults.read,
          headers: { location: "/elsewhere" },
        });
      const object = objects.get(path);
      if (!object) return new Response(null, { status: 404 });
      return new Response(
        req.method === "HEAD" ? null : new Uint8Array(object.bytes),
        {
          headers: {
            "content-type": object.mime,
            "content-length": String(object.bytes.length),
          },
        },
      );
    },
  });
  return {
    server,
    objects,
    directories,
    requests,
    faults,
    endpoint: server.url.origin + "/dav/",
  };
}

test("WebDAV HTTP protocol: conditional PUT, encoded directories, stream reads, conservative recovery and idempotent DELETE", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint, {
      keyPrefix: "中文 folder/100%",
    });
    const input = {
      operationId: "operation-1",
      fileId: crypto.randomUUID(),
      storageKey: "public/name.png",
      file: file(),
    };
    const result = await storage.write(input, context());
    const path = "/dav/%E4%B8%AD%E6%96%87%20folder/100%25/public/name.png";
    expect(result.locator).toBeNull();
    expect(dav.objects.get(path)?.bytes).toEqual(
      new TextEncoder().encode("image bytes"),
    );
    expect(
      dav.requests.filter((r) => r.method === "MKCOL").map((r) => r.path),
    ).toEqual([
      "/dav/%E4%B8%AD%E6%96%87%20folder/",
      "/dav/%E4%B8%AD%E6%96%87%20folder/100%25/",
      "/dav/%E4%B8%AD%E6%96%87%20folder/100%25/public/",
    ]);
    const put = dav.requests.find((r) => r.method === "PUT")!;
    expect(put.headers.get("if-none-match")).toBe("*");
    expect(put.headers.get("content-length")).toBe("11");
    for (const mode of ["auto", "stream"] as const) {
      const read = await storage.read(
        { storageKey: input.storageKey, locator: result.locator!, mode },
        context(),
      );
      expect(read.type).toBe("stream");
      if (read.type === "stream") {
        expect(read.byteSize).toBe(11);
        expect(read.mimeType).toBe("image/png");
        expect(await new Response(read.stream).text()).toBe("image bytes");
      }
    }
    expect(
      await storage.recoverWrite!(
        { ...input, expectedSize: 11, locator: result.locator! },
        context(),
      ),
    ).toEqual({ status: "unknown" });
    await expect(storage.write(input, context())).rejects.toMatchObject({
      code: "WEBDAV_CONFLICT",
      outcome: "notApplied",
    });
    expect(dav.objects.get(path)?.bytes).toEqual(
      new TextEncoder().encode("image bytes"),
    );
    await storage.delete({ ...input, locator: result.locator! }, context());
    await storage.delete({ ...input, locator: result.locator! }, context());
    expect(
      await storage.recoverWrite!(
        { ...input, expectedSize: 11, locator: null },
        context(),
      ),
    ).toEqual({ status: "notStored" });
    await expect(
      storage.read(
        {
          storageKey: input.storageKey,
          locator: result.locator!,
          mode: "stream",
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(storage.listFiles).toBeUndefined();
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV cannot infer write ownership after a failed response or from HEAD size", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    const input = {
      operationId: "lost-response",
      fileId: crypto.randomUUID(),
      storageKey: "x",
      file: file(),
    };
    dav.faults.put = 500;
    await expect(storage.write(input, context())).rejects.toMatchObject({
      code: "WEBDAV_PUT",
      retryable: true,
      outcome: "unknown",
    });
    expect(dav.objects.size).toBe(1);
    expect(
      await storage.recoverWrite!(
        { ...input, expectedSize: 11, locator: null },
        context(),
      ),
    ).toEqual({ status: "unknown" });
    for (const status of [200, 401, 403, 405, 500]) {
      dav.faults.head = status;
      expect(
        await storage.recoverWrite!(
          { ...input, expectedSize: 11, locator: null },
          context(),
        ),
      ).toEqual({ status: "unknown" });
    }
    const aborted = AbortSignal.abort();
    expect(
      await storage.recoverWrite!(
        { ...input, expectedSize: 11, locator: null },
        context(aborted),
      ),
    ).toEqual({ status: "unknown" });
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV refuses redirect, partial read and ambiguous deletion responses without leaking error body", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    for (const status of [302, 401, 403, 206]) {
      dav.faults.read = status;
      const before = dav.requests.length;
      try {
        await storage.read(
          { storageKey: "legacy.png", locator: null, mode: "auto" },
          context(),
        );
        throw new Error("Expected read failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect(String(error)).not.toContain("secret:password");
      }
      expect(dav.requests.length).toBe(before + 1);
    }
    for (const status of [202, 207, 302, 500]) {
      dav.faults.remove = status;
      await expect(
        storage.delete(
          { operationId: "delete", storageKey: "legacy.png", locator: null },
          context(),
        ),
      ).rejects.toBeInstanceOf(PluginError);
    }
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV rejects invalid locators, logical keys and unknown sizes before HTTP; existing non-collection cannot produce successful write", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    for (const locator of [
      { key: "../escape" },
      { key: "/absolute" },
      { key: "https://evil/path" },
      "https://evil",
      { key: "a\\b" },
    ]) {
      await expect(
        storage.read({ storageKey: "x", locator, mode: "stream" }, context()),
      ).rejects.toMatchObject({ code: "LOCATOR" });
    }
    const input = {
      operationId: "x",
      fileId: "../escape",
      storageKey: "../escape",
      file: file(),
    };
    await expect(storage.write(input, context())).rejects.toMatchObject({
      code: "LOCATOR",
    });
    await expect(
      storage.write(
        {
          ...input,
          fileId: "valid",
          file: { ...file(), metadata: { ...file().metadata, byteSize: null } },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "WEBDAV_SIZE" });
    expect(dav.requests).toHaveLength(0);
    dav.objects.set("/dav/objects", { bytes: new Uint8Array(), mime: "" });
    await expect(
      storage.write(
        { ...input, fileId: "valid", storageKey: "objects/sub/child" },
        context(),
      ),
    ).rejects.toBeInstanceOf(PluginError);
    expect(dav.requests.some((r) => r.method === "PUT")).toBe(false);
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV raw legacy names are encoded once and DELETE addresses the file path", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    const logical = "中文 文件/100%2F.png";
    const path = "/dav/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6/100%252F.png";
    dav.objects.set(path, {
      bytes: new TextEncoder().encode("legacy"),
      mime: "image/png",
    });
    const read = await storage.read(
      { storageKey: logical, locator: null, mode: "stream" },
      context(),
    );
    if (read.type === "stream")
      expect(await new Response(read.stream).text()).toBe("legacy");
    await storage.delete(
      { operationId: "x", storageKey: logical, locator: null },
      context(),
    );
    expect(
      dav.requests.filter((r) => r.method === "DELETE").map((r) => r.path),
    ).toEqual([path]);
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV releases upload source on rejection, incomplete body and cancellation", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    let source: ReadableStream<Uint8Array> | undefined;
    const tracked: FileInput = {
      ...file(),
      async openRead() {
        source = new Blob(["image bytes"]).stream();
        return source;
      },
    };
    dav.faults.put = 500;
    await expect(
      storage.write(
        {
          operationId: "fail",
          fileId: "failed",
          storageKey: "x",
          file: tracked,
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(PluginError);
    expect(source?.locked).toBe(false);
    const short: FileInput = {
      ...tracked,
      metadata: { ...tracked.metadata, byteSize: 100 },
    };
    await expect(
      storage.write(
        { operationId: "short", fileId: "short", storageKey: "x", file: short },
        context(),
      ),
    ).rejects.toBeInstanceOf(PluginError);
    expect(source?.locked).toBe(false);
    let cancelled = false;
    const abort = new AbortController();
    const blocked: FileInput = {
      ...file(),
      metadata: { ...file().metadata, byteSize: 100000 },
      async openRead() {
        source = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(1));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        });
        return source;
      },
    };
    const writing = storage.write(
      { operationId: "abort", fileId: "abort", storageKey: "x", file: blocked },
      context(abort.signal),
    );
    const timer = setTimeout(() => abort.abort(), 30);
    try {
      await expect(writing).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(cancelled).toBe(true);
    expect(source?.locked).toBe(false);
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV endpoint validation rejects ambiguous URLs and preserves sensitive immutable schema", async () => {
  for (const endpoint of [
    "ftp://example.com/dav",
    "https://user:password@example.com/dav",
    "https://example.com/dav?token=x",
    "https://example.com/dav#fragment",
    "https://example.com/dav/%2fescape",
    "https://example.com/dav/%5cescape",
    "https://example.com/%invalid",
  ]) {
    expect(await webdavStorage.validateConfig!({ endpoint })).toContainEqual({
      path: "/endpoint",
      message: "Invalid WebDAV endpoint",
    });
  }
  for (const keyPrefix of ["../escape", "/root", "a//b", "a/", "a\\b"]) {
    expect(
      await webdavStorage.validateConfig!({
        endpoint: "https://example.com/dav",
        keyPrefix,
      }),
    ).toContainEqual({ path: "/keyPrefix", message: "Invalid directory prefix" });
  }
  expect(
    await webdavStorage.validateConfig!({
      endpoint: "https://example.com/dav",
      keyPrefix: "中文/space %value",
    }),
  ).toEqual([]);
  const properties = webdavStorage.configSchema.properties as Config;
  expect((properties.endpoint as Config)["x-immutable"]).toBe(true);
  expect((properties.keyPrefix as Config)["x-immutable"]).toBe(true);
  expect((properties.username as Config)["x-sensitive"]).toBe(true);
  expect((properties.password as Config)["x-sensitive"]).toBe(true);
});

test("WebDAV read cancellation and abort close the real HTTP response", async () => {
  let disconnected: (() => void) | undefined;
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(Buffer.from("initial chunk"));
    response.once("close", () => disconnected?.());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const storage = await runtime("http://127.0.0.1:" + port + "/dav/", {
      timeoutMs: 100,
    });
    for (const method of ["cancel", "abort", "timeout"]) {
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const abort = new AbortController();
      const read = await storage.read(
        { storageKey: "stream.png", locator: null, mode: "stream" },
        context(abort.signal),
      );
      if (read.type !== "stream") throw new Error("Expected stream");
      const reader = read.stream.getReader();
      expect((await reader.read()).value).toEqual(
        new TextEncoder().encode("initial chunk"),
      );
      if (method === "cancel") await reader.cancel();
      else {
        if (method === "abort") abort.abort();
        await expect(reader.read()).rejects.toThrow();
      }
      reader.releaseLock();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("HTTP response did not close")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WebDAV concurrent creation preserves the first object", async () => {
  const dav = davServer();
  try {
    const storage = await runtime(dav.endpoint);
    const results = await Promise.allSettled(
      ["first", "other"].map((text) =>
        storage.write(
          {
            operationId: text,
            fileId: "concurrent",
            storageKey: "x",
            file: file(text),
          },
          context(),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe(
      "WEBDAV_CONFLICT",
    );
    expect(dav.objects.size).toBe(1);
    expect(["first", "other"]).toContain(
      new TextDecoder().decode(dav.objects.get("/dav/x")?.bytes),
    );
  } finally {
    await dav.server.stop(true);
  }
});

test("WebDAV operation deadline bounds stalled recovery and directory creation", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const storage = await runtime(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      { timeoutMs: 100 },
    );
    const input = {
      operationId: "op",
      fileId: "id",
      storageKey: "nested/a.png",
      file: file(),
    };
    expect(
      await storage.recoverWrite!(
        { ...input, expectedSize: 11, locator: null },
        context(),
      ),
    ).toEqual({ status: "unknown" });
    await expect(storage.write(input, context())).rejects.toMatchObject({
      code: "WEBDAV_MKCOL",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 3000);
