import sharp from "sharp";
import { test, expect } from "bun:test";
import { openListStorage } from "../src/builtins/storage/openlist/index";
import {
  PluginError,
  type Config,
  type InstanceServices,
  type FileInput,
} from "../src/plugins/api";

const token = "private-openlist-token";
const ctx = () => ({
  signal: AbortSignal.timeout(5000),
  requestId: "openlist-test",
  log() {},
});
function services(): InstanceServices {
  return {
    images: { sharp },
    log() {},
    async readSecrets() {
      return { value: { token }, version: 1 };
    },
    async updateSecrets() {},
    async readState() {
      return { value: {}, version: 1 };
    },
    async updateState() {},
  };
}
const bytes = new TextEncoder().encode("<svg>test</svg>");
function input(): FileInput {
  return {
    metadata: {
      byteSize: bytes.length,
      mimeType: "image/svg+xml",
      width: 1,
      height: 1,
    },
    async openRead() {
      return new Blob([bytes]).stream();
    },
  };
}
async function instance(endpoint: string, extra: Config = {}) {
  return openListStorage.createInstance({
    id: "openlist-test",
    config: { endpoint, root: "/挂载 a%#", timeoutMs: 30000, ...extra },
    services: services(),
  });
}
function success(data?: unknown) {
  return Response.json({ code: 200, message: "success", data });
}

test("OpenList HTTP protocol: PUT, fresh raw URL, credential-free download, remove and isolation", async () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  let downloads = 0,
    compressed = false;
  const cdn = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      expect(req.headers.get("authorization")).toBeNull();
      downloads++;
      return new Response(compressed ? Bun.gzipSync(bytes) : bytes, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Content-Length": String(
            compressed ? Bun.gzipSync(bytes).length : bytes.length,
          ),
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        },
      });
    },
  });
  let gets = 0;
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      expect(req.headers.get("authorization")).toBe(token);
      const route = new URL(req.url).pathname;
      if (route === "/base/api/fs/put") {
        expect(req.method).toBe("PUT");
        expect(req.headers.get("As-Task")).toBe("false");
        expect(req.headers.get("Overwrite")).toBe("false");
        expect(req.headers.get("Content-Type")).toBe("image/svg+xml");
        expect(req.headers.get("Content-Length")).toBe(String(bytes.length));
        const path = decodeURIComponent(req.headers.get("File-Path")!);
        expect(path.startsWith("/挂载 a%#/")).toBe(true);
        if (objects.has(path)) return Response.json({ code: 409 });
        objects.set(path, new Uint8Array(await req.arrayBuffer()));
        return success();
      }
      expect(req.method).toBe("POST");
      expect(req.headers.get("content-type")).toBe("application/json");
      const data = await req.json();
      if (route === "/base/api/fs/get") {
        gets++;
        expect(objects.has(data.path)).toBe(true);
        expect(data.password).toBe("");
        return success({
          is_dir: false,
          raw_url: cdn.url.href + "?sign=" + gets,
          header: "<h1>directory HTML</h1>",
        });
      }
      expect(route).toBe("/base/api/fs/remove");
      expect(data.dir).toBe("/挂载 a%#");
      expect(data.names).toHaveLength(1);
      objects.delete(data.dir + "/" + data.names[0]);
      return success();
    },
  });
  try {
    const runtime = await instance(remote.url.href + "base");
    const first = await runtime.write(
      {
        operationId: "op1",
        fileId: "file-1",
        storageKey: "same.svg",
        file: input(),
      },
      ctx(),
    );
    const second = await runtime.write(
      {
        operationId: "op2",
        fileId: "file-2",
        storageKey: "second.svg",
        file: input(),
      },
      ctx(),
    );
    expect(first.locator).toBeNull();
    expect(second.locator).toBeNull();
    expect([...objects.keys()]).toEqual([
      "/挂载 a%#/same.svg",
      "/挂载 a%#/second.svg",
    ]);
    await expect(
      runtime.write(
        {
          operationId: "collision",
          fileId: "other",
          storageKey: "same.svg",
          file: input(),
        },
        ctx(),
      ),
    ).rejects.toThrow();
    expect(objects.size).toBe(2);
    expect([...objects.values()][0]).toEqual(bytes);
    const redirect = await runtime.read(
      { storageKey: "same.svg", locator: first.locator!, mode: "auto" },
      ctx(),
    );
    expect(redirect).toEqual({
      type: "redirect",
      url: cdn.url.href + "?sign=1",
    });
    const stream = await runtime.read(
      { storageKey: "same.svg", locator: first.locator!, mode: "stream" },
      ctx(),
    );
    expect(stream.type).toBe("stream");
    if (stream.type === "stream") {
      expect(stream.mimeType).toBe("image/svg+xml");
      expect(stream.byteSize).toBe(bytes.length);
      expect(
        new Uint8Array(await new Response(stream.stream).arrayBuffer()),
      ).toEqual(bytes);
    }
    expect(downloads).toBe(1);
    compressed = true;
    const compressedRead = await runtime.read(
      { storageKey: "same.svg", locator: first.locator!, mode: "stream" },
      ctx(),
    );
    expect(compressedRead.type).toBe("stream");
    if (compressedRead.type === "stream") {
      expect(compressedRead.byteSize).toBeUndefined();
      expect(
        new Uint8Array(await new Response(compressedRead.stream).arrayBuffer()),
      ).toEqual(bytes);
    }
    compressed = false;
    const physicalName = "same.svg";
    expect(
      await runtime.read(
        { storageKey: physicalName, locator: null, mode: "auto" },
        ctx(),
      ),
    ).toMatchObject({ type: "redirect" });
    objects.set("/挂载 a%#/existing/nested.svg", new Uint8Array(bytes));
    expect(
      await runtime.read(
        {
          storageKey: "existing/nested.svg",
          locator: { path: "/挂载 a%#/existing/nested.svg" },
          mode: "auto",
        },
        ctx(),
      ),
    ).toMatchObject({ type: "redirect" });
    objects.delete("/挂载 a%#/existing/nested.svg");
    const forced = await instance(remote.url.href + "base", {
      redirect: false,
    });
    const forcedRead = await forced.read(
      { storageKey: "same.svg", locator: first.locator!, mode: "auto" },
      ctx(),
    );
    expect(forcedRead.type).toBe("stream");
    if (forcedRead.type === "stream") await forcedRead.stream.cancel();
    expect(
      await runtime.recoverWrite!(
        {
          operationId: "op1",
          fileId: "file-1",
          storageKey: "same.svg",
          expectedSize: bytes.length,
          locator: first.locator!,
        },
        ctx(),
      ),
    ).toEqual({ status: "unknown" });
    await runtime.delete(
      { operationId: "del", storageKey: "same.svg", locator: first.locator! },
      ctx(),
    );
    await runtime.delete(
      {
        operationId: "del-again",
        storageKey: "same.svg",
        locator: first.locator!,
      },
      ctx(),
    );
    expect(objects.size).toBe(1);
    await expect(
      runtime.delete(
        {
          operationId: "bad",
          storageKey: "same.svg",
          locator: { path: "/挂载 a%#/../other" },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", outcome: "notApplied" });
    expect(runtime.listFiles).toBeFunction();
  } finally {
    remote.stop(true);
    cdn.stop(true);
  }
});

test("OpenList rejects API redirects, auth errors, false success, async PUT, secret URLs and unsupported download URLs", async () => {
  let mode = "denied",
    redirected = 0;
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      redirected++;
      return success();
    },
  });
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      await req.arrayBuffer();
      if (new URL(req.url).pathname === "/missing")
        return new Response("upstream error " + token, { status: 500 });
      if (mode === "redirect") return Response.redirect(sink.url.href, 307);
      if (mode === "http-denied") return new Response(token, { status: 401 });
      if (mode === "denied")
        return Response.json({ code: 403, message: token });
      if (mode === "http-rate-limit")
        return new Response(null, { status: 429 });
      if (mode === "json-rate-limit") return Response.json({ code: 429 });
      if (mode === "malformed") return new Response("not JSON " + token);
      if (mode === "async") return success({ task: { id: "background" } });
      if (mode === "secret")
        return success({
          is_dir: false,
          raw_url: sink.url.href + "?token=" + token,
        });
      if (mode === "scheme")
        return success({ is_dir: false, raw_url: "file:///etc/passwd" });
      if (mode === "cdn-error")
        return success({ is_dir: false, raw_url: remote.url.href + "missing" });
      return new Response("upstream error " + token, { status: 500 });
    },
  });
  try {
    const runtime = await instance(remote.url.href);
    const write = () =>
      runtime.write(
        { operationId: "op", fileId: "id", storageKey: "a.svg", file: input() },
        ctx(),
      );
    for (const value of [
      "denied",
      "http-denied",
      "malformed",
      "async",
      "redirect",
    ]) {
      mode = value;
      let caught: unknown;
      try {
        await write();
      } catch (cause) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(PluginError);
      expect(String(caught)).not.toContain(token);
      expect(caught).toMatchObject({
        outcome: value.includes("denied") ? "notApplied" : "unknown",
        retryable: false,
      });
      if (value === "malformed")
        expect(caught).toMatchObject({ code: "INVALID_DATA" });
    }
    expect(redirected).toBe(0);
    const read = () =>
      runtime.read(
        {
          storageKey: "a.svg",
          locator: { path: "/挂载 a%#/picloom-id.svg" },
          mode: "stream",
        },
        ctx(),
      );
    for (const value of ["secret", "scheme", "cdn-error"]) {
      mode = value;
      await expect(read()).rejects.toBeInstanceOf(PluginError);
    }
    for (const value of ["http-rate-limit", "json-rate-limit", "unavailable"]) {
      mode = value;
      const limited = value.endsWith("rate-limit");
      await expect(write()).rejects.toMatchObject({
        outcome: limited ? "notApplied" : "unknown",
        retryable: limited,
      });
      await expect(
        runtime.delete(
          { operationId: "del", storageKey: "a.svg", locator: null },
          ctx(),
        ),
      ).rejects.toMatchObject({
        outcome: limited ? "notApplied" : "unknown",
        retryable: true,
      });
    }
    mode = "malformed";
    await expect(
      runtime.delete(
        {
          operationId: "del",
          storageKey: "a.svg",
          locator: { path: "/挂载 a%#/picloom-id.svg" },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ outcome: "unknown", retryable: true });
    expect(redirected).toBe(0);
  } finally {
    remote.stop(true);
    sink.stop(true);
  }
});

test("OpenList validates configuration and cancels/releases upload input on abort", async () => {
  for (const endpoint of [
    "ftp://host",
    "https://user:secret@host",
    "https://host?token=private",
    "https://host/#hash",
  ]) {
    expect(
      await openListStorage.validateConfig!({ endpoint, root: "/root" }),
    ).toContainEqual({
      path: "/endpoint",
      message: "Invalid OpenList endpoint",
    });
  }
  for (const root of ["relative", "/x/", "/../x", "/a//b", "/a\\b", "/a\nb"]) {
    expect(
      (
        await openListStorage.validateConfig!({
          endpoint: "https://host",
          root,
        })
      ).some((issue) => issue.path === "/root"),
    ).toBe(true);
  }
  expect(
    await openListStorage.validateConfig!({
      endpoint: "https://host/base",
      root: "/",
    }),
  ).toEqual([]);
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      await req.arrayBuffer().catch(() => {});
      return success();
    },
  });
  try {
    const runtime = await instance(remote.url.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await expect(
        runtime.write(
          {
            operationId: "op",
            fileId: "id",
            storageKey: "a.svg",
            file: {
              ...input(),
              async openRead() {
                return source;
              },
            },
          },
          { ...ctx(), signal: controller.signal },
        ),
      ).rejects.toMatchObject({ outcome: "unknown", retryable: false });
    } finally {
      clearTimeout(timer);
    }
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  } finally {
    remote.stop(true);
  }
});

test("OpenList connection refusal is a retryable failure with no remote write", async () => {
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return success();
    },
  });
  const endpoint = remote.url.href;
  await remote.stop(true);
  const runtime = await instance(endpoint);
  await expect(
    runtime.write(
      { operationId: "op", fileId: "id", storageKey: "a.svg", file: input() },
      ctx(),
    ),
  ).rejects.toMatchObject({
    code: "NETWORK",
    outcome: "notApplied",
    retryable: true,
  });
});

test("OpenList request preparation failures do not become network or unknown writes", async () => {
  let requests = 0;
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return success();
    },
  });
  try {
    const runtime = await openListStorage.createInstance({
      id: "preparation-test",
      config: { endpoint: remote.url.href, root: "/images", timeoutMs: 30000 },
      services: {
        ...services(),
        async readSecrets() {
          throw new Error("secret failure " + token);
        },
      },
    });
    let caught: unknown;
    try {
      await runtime.write(
        { operationId: "op", fileId: "id", storageKey: "a.svg", file: input() },
        ctx(),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "FAILED",
      outcome: "notApplied",
      retryable: false,
    });
    expect(String(caught)).not.toContain(token);
    expect(requests).toBe(0);
  } finally {
    await remote.stop(true);
  }
});

test("OpenList lost response after receiving the upload remains an unknown write", async () => {
  let received = false;
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(new Uint8Array(await req.arrayBuffer())).toEqual(bytes);
      received = true;
      void remote.stop(true);
      return success();
    },
  });
  try {
    const runtime = await instance(remote.url.href);
    await expect(
      runtime.write(
        { operationId: "op", fileId: "id", storageKey: "a.svg", file: input() },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "NETWORK",
      outcome: "unknown",
      retryable: false,
    });
    expect(received).toBe(true);
  } finally {
    await remote.stop(true);
  }
});

test("OpenList enumeration resumes nested and paginated directories without changing storage keys", async () => {
  const entry = (name: string, is_dir = false) => ({
    name,
    is_dir,
    size: is_dir ? 0 : 12,
  });
  const directories: Record<string, ReturnType<typeof entry>[] | null> = {
    "/挂载 a%#/album": [
      entry("子目录 %", true),
      ...Array.from({ length: 205 }, (_, i) => entry(`${i}.png`)),
    ],
    "/挂载 a%#/album/子目录 %": [entry("empty", true), entry("image %.png")],
    "/挂载 a%#/album/子目录 %/empty": null,
  };
  let calls = 0;
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      calls++;
      expect(new URL(req.url).pathname).toBe("/base/api/fs/list");
      expect(req.headers.get("Authorization")).toBe(token);
      const { path, page, per_page, refresh, password } = await req.json();
      expect(refresh).toBe(false);
      expect(password).toBe("");
      expect(per_page).toBe(200);
      expect(path in directories).toBe(true);
      const entries = directories[path];
      return success({
        content: entries?.slice((page - 1) * per_page, page * per_page) ?? null,
        total: entries?.length ?? 0,
      });
    },
  });
  try {
    const runtime = await instance(remote.url.href + "base");
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const before = calls;
      const result = await runtime.listFiles!(
        { scope: "album/", cursor, limit: 37 },
        ctx(),
      );
      expect(calls - before).toBeLessThanOrEqual(8);
      expect(result.items.length).toBeLessThanOrEqual(37);
      for (const item of result.items) {
        expect(item.byteSize).toBe(12);
        keys.push(item.storageKey);
      }
      if (result.nextCursor) expect(result.nextCursor).not.toBe(cursor);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(keys).toEqual([
      "album/子目录 %/image %.png",
      ...Array.from({ length: 205 }, (_, i) => `album/${i}.png`),
    ]);
  } finally {
    remote.stop(true);
  }
});

test("OpenList enumeration bounds empty-directory work and rejects unsafe cursors, entries and upstream errors", async () => {
  let mode = "empty-tree",
    calls = 0;
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      calls++;
      const { path } = await req.json();
      if (mode === "denied") return Response.json({ code: 403 });
      if (mode === "empty-tree")
        return success({
          content:
            path === "/"
              ? Array.from({ length: 12 }, (_, i) => ({
                  name: `dir${i}`,
                  is_dir: true,
                  size: 0,
                }))
              : null,
          total: path === "/" ? 12 : 0,
        });
      return success({
        content: [{ name: mode, is_dir: false, size: 1 }],
        total: 1,
      });
    },
  });
  try {
    const runtime = await instance(remote.url.href, { root: "/" });
    const first = await runtime.listFiles!({ limit: 200 }, ctx());
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(calls).toBe(8);
    const second = await runtime.listFiles!(
      { limit: 200, cursor: first.nextCursor! },
      ctx(),
    );
    expect(second).toEqual({ items: [], nextCursor: null });
    const before = calls;
    for (const directory of [
      "../outside",
      "/outside",
      "album/../../outside",
      "other",
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({
          scope: "album",
          data: [{ directory, page: 1, index: 0 }],
        }),
      ).toString("base64url");
      await expect(
        runtime.listFiles!({ scope: "album", cursor, limit: 200 }, ctx()),
      ).rejects.toBeInstanceOf(Error);
    }
    await expect(
      runtime.listFiles!(
        { scope: "album", cursor: first.nextCursor!, limit: 200 },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(before);
    for (mode of ["../escape.png", "a/b.png", "a\\b.png", ".", ""]) {
      await expect(
        runtime.listFiles!({ limit: 200 }, ctx()),
      ).rejects.toMatchObject({ code: "INVALID_DATA" });
    }
    mode = "denied";
    await expect(
      runtime.listFiles!({ limit: 200 }, ctx()),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    remote.stop(true);
  }
});
