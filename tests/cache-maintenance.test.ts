import * as fs from "node:fs/promises";
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm, utimes, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageCache, type ImageResult } from "../src/core/cache";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
const output = (size: number): ImageResult => ({
  bytes: new Uint8Array(size),
  metadata: {
    mimeType: "image/webp",
    byteSize: size,
    width: 1,
    height: 1,
    animated: false,
    alpha: false,
  },
});
test("cache maintenance throttles scans, applies new limits and serializes clear with writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "star-cache-maintenance-"));
  try {
    const cache = new ImageCache(root, 2, 60000);
    await cache.put("file", "first", output(1));
    await utimes(
      join(root, "file", "first", "image"),
      new Date(Date.now() - 1000),
      new Date(Date.now() - 1000),
    );
    await cache.put("file", "second", output(2));
    expect(await cache.get("file", "first")).toBeNull();
    await cache.clean(false);
    expect(await cache.get("file", "first")).toBeNull();
    await cache.clean();
    expect(await cache.get("file", "first")).toBeNull();
    const second = await cache.get("file", "second");
    expect(second).not.toBeNull();
    await second!.stream.cancel();
    cache.configure(1, 60000);
    await cache.clean(false);
    expect(await cache.get("file", "second")).toBeNull();
    cache.configure(100, 60000);
    await cache.put("file", "third", output(1));
    await utimes(
      join(root, "file", "third", "image"),
      new Date(Date.now() - 2000),
      new Date(Date.now() - 2000),
    );
    cache.configure(100, 1000);
    await cache.clean(false);
    expect(await cache.get("file", "third")).toBeNull();
    await Promise.all([cache.put("file", "last", output(1)), cache.clear()]);
    expect(await cache.get("file", "last")).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("admin cache clear requires CSRF, preserves originals, and settings update live limits", async () => {
  const f = await fixture();
  try {
    const upload = await (await f.upload()).json();
    const thumb = `/api/files/${upload.id}/thumbnail`;
    const first = await f.request(thumb);
    const etag = first.headers.get("etag");
    await first.arrayBuffer();
    const handle = handler(f.app);
    const endpoint = "/api/system/cache/clear";
    expect(
      (
        await handle(
          new Request("http://localhost" + endpoint, { method: "POST" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handle(
          new Request("http://localhost" + endpoint, {
            method: "POST",
            headers: { cookie: f.cookie },
          }),
        )
      ).status,
    ).toBe(403);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request(endpoint, "POST", undefined, token.token)).status,
    ).toBe(403);
    expect((await f.request(endpoint, "POST")).status).toBe(200);
    expect(await readdir(join(f.root, "cache"))).toEqual([]);
    const original = await f.request(new URL(upload.url).pathname);
    expect(original.status).toBe(200);
    await original.arrayBuffer();
    const regenerated = await f.request(thumb);
    expect(regenerated.headers.get("etag")).not.toBe(etag);
    await regenerated.arrayBuffer();
    const settings = await (await f.request("/api/settings")).json();
    expect(
      (
        await f.request("/api/settings", "PUT", {
          ...settings,
          cacheBytes: 1,
          cacheTtlMs: 60000,
        })
      ).status,
    ).toBe(200);
    await f.app.files.cache.clean(false);
    expect(await readdir(join(f.root, "cache", upload.id))).toEqual([]);
    await f.restart();
    expect(f.app.config.cacheBytes).toBe(1);
    expect(f.app.config.cacheTtlMs).toBe(60000);
  } finally {
    await f.close();
  }
});

test("cache scans remove incomplete entries and empty directories while retaining valid images", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-cache-residue-"));
  try {
    const cache = new ImageCache(root, 100, 60000);
    await cache.put("valid", "key", output(1));
    for (const name of [
      "missing-image",
      "missing-meta",
      "invalid-meta",
      ".tmp-interrupted",
    ]) {
      const path = join(root, "broken", name);
      await mkdir(path, { recursive: true });
      if (name !== "missing-image")
        await Bun.write(join(path, "image"), new Uint8Array(1));
      if (name !== "missing-meta")
        await Bun.write(join(path, "meta.json"), "{");
    }
    await mkdir(join(root, "empty"));
    await cache.clean();
    expect(await readdir(root)).toEqual(["valid"]);
    const valid = await cache.get("valid", "key");
    expect(valid).not.toBeNull();
    await valid!.stream.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an opened cache stream survives eviction without holding the cache lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-cache-stream-"));
  try {
    const cache = new ImageCache(root, 1024 * 1024, 60000);
    const value = output(512 * 1024);
    value.bytes.fill(37);
    await cache.put("file", "key", value);
    const hit = (await cache.get("file", "key"))!;
    expect(hit.size).toBe(value.bytes.length);
    await cache.clear();
    expect(await readdir(root)).toEqual([]);
    const received: Uint8Array = new Uint8Array(
      await new Response(hit.stream).arrayBuffer(),
    );
    expect(received).toEqual(value.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed eviction skips new cache writes and recovers after deletion succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-cache-capacity-"));
  const cache = new ImageCache(root, 10, 60000);
  const original = fs.rm;
  let removal: ReturnType<typeof spyOn> | undefined;
  try {
    await cache.put("file", "old", output(8));
    removal = spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path) === join(root, "file", "old"))
        throw Object.assign(new Error("Deletion failed"), { code: "EACCES" });
      return original(path, options);
    });
    await cache.put("file", "new", output(8));
    expect(await readdir(join(root, "file"))).toEqual(["old"]);
    removal.mockRestore();
    removal = undefined;
    await cache.put("file", "new", output(8));
    expect(await readdir(join(root, "file"))).toEqual(["new"]);
  } finally {
    removal?.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
