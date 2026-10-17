import { test, expect } from "bun:test";
import { mkdtemp, rm, utimes, readdir } from "node:fs/promises";
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
    expect(await cache.get("file", "first")).not.toBeNull();
    await cache.clean(false);
    expect(await cache.get("file", "first")).not.toBeNull();
    await cache.clean();
    expect(await cache.get("file", "first")).toBeNull();
    expect(await cache.get("file", "second")).not.toBeNull();
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
