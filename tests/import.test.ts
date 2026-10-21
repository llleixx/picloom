import { test, expect, spyOn } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";
import { importMimeTypes } from "../shared/import";
const ctx = () => ({
  signal: AbortSignal.timeout(10000),
  requestId: "import-test",
  log() {},
});
async function source(f: Awaited<ReturnType<typeof fixture>>, name = "legacy") {
  return f.app.plugins.save({
    pluginId: "builtin.local",
    version: "1.0.0",
    name,
    config: { root: join(f.root, name) },
  });
}
async function scan(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  options: Record<string, unknown> = {},
) {
  const res = await f.request(`/api/storage-sources/${id}/import`, "POST", {
    publicPrefix: "/legacy/",
    mimeTypes: [...importMimeTypes],
    ...options,
  });
  expect(res.status).toBe(200);
  return res.json();
}
test("local in-place import preserves paths, metadata, duplicate safety, reads, restart and physical deletion", async () => {
  const f = await fixture();
  try {
    const src = await source(f);
    const root = join(f.root, "legacy");
    await mkdir(join(root, "2024"));
    await Bun.write(join(root, "2024/中文.png"), f.png);
    await Bun.write(
      join(root, "2024/vector.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
    );
    await Bun.write(join(root, "2024/not-image.txt"), "skip");
    await symlink(join(root, "2024/中文.png"), join(root, "2024/link.png"));
    const first = await scan(f, src.id, { scope: "2024/" });
    expect(first).toMatchObject({
      imported: 2,
      skipped: 1,
      conflicts: 0,
      failed: 0,
      nextCursor: null,
    });
    const files = await f.app.db.read((r) => r.files(30, 0));
    const file = files.find((x) => x.logical_key.endsWith(".png"))!;
    expect(file).toMatchObject({
      upload_profile_id: null,
      storage_group_id: null,
      mime_type: null,
      width: null,
      temp_path: null,
      temp_status: "cleaned",
    });
    expect(await f.app.db.read((r) => r.tasks(file.id))).toEqual([]);
    expect(
      (await f.app.db.read((r) => r.replicas(file.id)))[0]!.locator_json,
    ).toBeNull();
    expect((await scan(f, src.id)).imported).toBe(0);
    expect((await scan(f, src.id, { publicPrefix: "/alias/" })).imported).toBe(
      0,
    );
    const original = await f.request(
      "/legacy/2024/" + encodeURIComponent("中文.png"),
    );
    expect(original.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
    const svg = await f.request("/legacy/2024/vector.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    await svg.text();
    const transformed = await f.request(
      "/legacy/2024/" + encodeURIComponent("中文.png") + "?w=10&format=webp",
    );
    expect(transformed.status).toBe(200);
    expect(
      (await sharp(await transformed.arrayBuffer()).metadata()).width,
    ).toBe(10);
    const other = await source(f, "other");
    await Bun.write(join(f.root, "other/2024/中文.png"), f.png);
    expect((await scan(f, other.id)).conflicts).toBe(1);
    await f.restart();
    expect((await scan(f, src.id)).imported).toBe(0);
    await f.request(`/api/files/${file.id}`, "DELETE");
    await f.app.files.tasks.sweep();
    expect(await Bun.file(join(root, "2024/中文.png")).exists()).toBe(false);
    await Bun.write(join(root, "2024/中文.png"), f.png);
    expect((await scan(f, src.id)).conflicts).toBe(1);
  } finally {
    await f.close();
  }
});
test("local enumeration is paged, repeatable and scoped; API rejects reserved prefixes and upload tokens", async () => {
  const f = await fixture();
  try {
    const src = await source(f),
      root = join(f.root, "legacy");
    for (const name of ["a/a.png", "a/b.png", "b/c.png"])
      await Bun.write(join(root, name), f.png);
    const lease = f.app.plugins.acquire(src.id, "storage");
    try {
      const one = await lease.runtime.listFiles!(
        { limit: 1, scope: "a" },
        ctx(),
      );
      expect(one.items.map((x) => x.storageKey)).toEqual(["a/a.png"]);
      const two = await lease.runtime.listFiles!(
        { limit: 1, scope: "a", cursor: one.nextCursor! },
        ctx(),
      );
      expect(two.items.map((x) => x.storageKey)).toEqual(["a/b.png"]);
      expect(
        await lease.runtime.listFiles!(
          { limit: 1, scope: "a", cursor: one.nextCursor! },
          ctx(),
        ),
      ).toEqual(two);
      await expect(
        lease.runtime.listFiles!(
          { limit: 1, scope: "b", cursor: one.nextCursor! },
          ctx(),
        ),
      ).rejects.toThrow();
      await expect(
        lease.runtime.listFiles!({ limit: 1, scope: "../" }, ctx()),
      ).rejects.toThrow();
    } finally {
      await lease.release();
    }
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (
        await f.request(
          `/api/storage-sources/${src.id}/import`,
          "POST",
          { publicPrefix: "/i/", mimeTypes: ["image/png"] },
          token.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(`/api/storage-sources/${src.id}/import`, "POST", {
          publicPrefix: "/app/",
          mimeTypes: ["image/png"],
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
test("S3 import lists only, keeps instance-relative keys, follows cursors and supports redirects, transforms and delete", async () => {
  const f = await fixture();
  const calls: string[] = [];
  let removed = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      calls.push(
        req.method +
          " " +
          u.pathname +
          (u.searchParams.has("list-type") ? " LIST" : ""),
      );
      if (u.searchParams.has("list-type")) {
        expect(u.searchParams.get("prefix")).toBe("legacy/photos");
        const second = u.searchParams.has("continuation-token");
        return new Response(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${!second}</IsTruncated>${second ? `<Contents><Key>legacy/photos/a.png</Key><Size>${f.png.length}</Size></Contents>` : "<NextContinuationToken>next</NextContinuationToken>"}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      expect(u.pathname).toBe("/bucket/legacy/photos/a.png");
      if (req.method === "DELETE") {
        removed = true;
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET")
        return new Response(new Uint8Array(f.png), {
          headers: { "content-type": "image/png" },
        });
      throw new Error("Unexpected object request during import");
    },
  });
  try {
    const src = await f.app.plugins.save({
      secretEdits: {
        "/accessKeyId": { action: "replace", value: "test" },
        "/secretAccessKey": { action: "replace", value: "test" },
      },
      pluginId: "builtin.s3",
      version: "1.0.0",
      name: "s3",
      config: {
        multipartThresholdMiB: 64,
        partSizeMiB: 16,
        partConcurrency: 3,
        forcePathStyle: true,
        signedUrlSeconds: 300,
        endpoint: server.url.origin,
        region: "test",
        bucket: "bucket",
        keyPrefix: "legacy",

        redirect: true,
      },
    });
    const one = await scan(f, src.id, { scope: "photos" });
    expect(one.scanned).toBe(0);
    expect(one.nextCursor).toBeString();
    const two = await scan(f, src.id, {
      scope: "photos",
      cursor: one.nextCursor,
    });
    expect(two.imported).toBe(1);
    expect(two.nextCursor).toBeNull();
    expect(calls).toEqual(["GET /bucket/ LIST", "GET /bucket/ LIST"]);
    const redirect = await f.request("/legacy/photos/a.png");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toContain("X-Amz-Signature");
    const processed = await f.request("/legacy/photos/a.png?w=10&format=webp");
    expect(processed.status).toBe(200);
    await processed.arrayBuffer();
    const file = (await f.app.db.read((r) => r.files(10, 0)))[0]!;
    await f.request(`/api/files/${file.id}`, "DELETE");
    await f.app.files.tasks.sweep();
    expect(removed).toBe(true);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("optional enumeration validates entries and never reads content; opaque locators deduplicate across paths", async () => {
  const f = await fixture();
  try {
    let enumeration = true;
    f.app.plugins.register({
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: {
        "en-US": {
          "package.name": "Enumerate",
        },
      },

      id: "test.enumerate",

      version: "1.0.0",
      apiVersion: 1,
      configSchemaVersion: 1,
      kind: "storage",
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async createInstance() {
        return {
          async write() {
            throw new Error("must not write");
          },
          async read() {
            throw new Error("must not read");
          },
          async delete() {},
          ...(enumeration
            ? {
                async listFiles() {
                  return {
                    items: [
                      {
                        storageKey: "ab/cd/a.png",
                        locator: { key: "remote", namespace: "test" },
                      },
                      {
                        storageKey: "xy/zz/b.png",
                        locator: { namespace: "test", key: "remote" },
                      },
                      { storageKey: "../bad.png" },
                      { storageKey: "negative.png", byteSize: -1 },
                    ],
                    nextCursor: null,
                  };
                },
              }
            : {}),
        };
      },
    });
    const src = await f.app.plugins.save({
      pluginId: "test.enumerate",
      version: "1.0.0",
      name: "enumerator",
      config: {},
    });
    expect((await f.app.plugins.view(src.id)).canImport).toBe(true);
    expect(await scan(f, src.id, { stripDirectories: 2 })).toMatchObject({
      imported: 1,
      skipped: 1,
      failed: 2,
    });
    expect((await scan(f, src.id, { stripDirectories: 2 })).imported).toBe(0);
    const imported = (await f.app.db.read((r) => r.files(10, 0)))[0]!;
    expect(imported.storage_key).toBe("ab/cd/a.png");
    expect(imported.logical_key).toBe("a.png");
    expect(
      (await f.app.db.read((r) => r.replicas(imported.id)))[0]!.locator_json,
    ).toEqual({ key: "remote", namespace: "test" });
    enumeration = false;
    await f.app.plugins.reinitialize(src.id);
    expect((await f.app.plugins.view(src.id)).canImport).toBe(false);
    const response = await f.request(
      `/api/storage-sources/${src.id}/import`,
      "POST",
      { publicPrefix: "/legacy/", mimeTypes: ["image/png"] },
    );
    expect((await response.json()).error.code).toBe("IMPORT_UNSUPPORTED");
  } finally {
    await f.close();
  }
});

test("metadata is learned lazily from original bytes, before transforms; thumbnail cache avoids more reads", async () => {
  const f = await fixture();
  try {
    const src = await source(f);
    for (const name of ["transform.png", "thumbnail.png", "failure.png"])
      await Bun.write(join(f.root, "legacy", name), f.png);
    await scan(f, src.id);
    const rows = await f.app.db.read((r) => r.files(10, 0));
    const transformed = rows.find((x) => x.logical_key === "transform.png")!;
    const thumb = rows.find((x) => x.logical_key === "thumbnail.png")!;
    const failure = rows.find((x) => x.logical_key === "failure.png")!;
    const reads = spyOn(f.app.files as any, "read");
    const original = await f.request("/legacy/transform.png");
    await original.arrayBuffer();
    expect(
      (await f.app.db.read((r) => r.file(transformed.id)))?.mime_type,
    ).toBeNull();
    // Transparent PNG cannot become JPEG, but identifying its source still succeeds.
    expect((await f.request("/legacy/transform.png?format=jpeg")).status).toBe(
      422,
    );
    expect(await f.app.db.read((r) => r.file(transformed.id))).toMatchObject({
      mime_type: "image/png",
      width: 40,
      height: 20,
      byte_size: f.png.length,
    });
    const converted = await f.request("/legacy/transform.png?w=10&format=webp");
    expect(converted.status).toBe(200);
    await converted.arrayBuffer();
    expect(await f.app.db.read((r) => r.file(transformed.id))).toMatchObject({
      mime_type: "image/png",
      width: 40,
      height: 20,
    });
    const before = reads.mock.calls.length;
    for (let i = 0; i < 2; i++) {
      const result = await f.request(`/api/files/${thumb.id}/thumbnail`);
      expect(result.status).toBe(200);
      await result.arrayBuffer();
    }
    expect(reads.mock.calls.length - before).toBe(1);
    expect(await f.app.db.read((r) => r.file(thumb.id))).toMatchObject({
      mime_type: "image/png",
      width: 40,
      height: 20,
    });
    const transaction = f.app.db.transaction.bind(f.app.db);
    const injection = spyOn(f.app.db, "transaction").mockImplementation((fn) =>
      transaction((r) =>
        fn(
          new Proxy(r, {
            get(target, key) {
              if (key === "fillFileMetadata")
                return async () => {
                  throw new Error("injected metadata save failure");
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
    );
    try {
      const result = await f.request(`/api/files/${failure.id}/thumbnail`);
      expect(result.status).toBe(200);
      await result.arrayBuffer();
      expect(
        (await f.app.db.read((r) => r.file(failure.id)))?.mime_type,
      ).toBeNull();
    } finally {
      injection.mockRestore();
      reads.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("import strips public directories without changing storage, and handles races, duplicates and collisions", async () => {
  const f = await fixture();
  try {
    const src = await source(f);
    const root = join(f.root, "legacy");
    await Bun.write(join(root, "ab/cd/photo.png"), f.png);
    await Bun.write(join(root, "xy/zz/photo.png"), f.png);
    await Bun.write(join(root, "short.png"), f.png);
    const options = { scope: "ab", stripDirectories: 2 };
    const results = await Promise.all([
      scan(f, src.id, options),
      scan(f, src.id, options),
    ]);
    expect(results.reduce((n, r) => n + r.imported, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(1);
    const file = (await f.app.db.read((r) => r.files(10, 0)))[0]!;
    expect(file).toMatchObject({
      logical_key: "photo.png",
      storage_key: "ab/cd/photo.png",
    });
    expect(
      new Uint8Array(
        await (await f.request("/legacy/photo.png")).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array(f.png));
    expect(await scan(f, src.id, { stripDirectories: 2 })).toMatchObject({
      imported: 0,
      skipped: 1,
      conflicts: 1,
      failed: 1,
    });
    expect(
      await scan(f, src.id, {
        scope: "ab",
        publicPrefix: "/alias/",
        stripDirectories: 0,
      }),
    ).toMatchObject({ imported: 0, skipped: 1 });
    expect(
      await scan(f, src.id, { scope: "ab", stripDirectories: 3 }),
    ).toMatchObject({
      failed: 1,
      issues: [{ logicalKey: "ab/cd/photo.png", code: "PATH_TOO_SHALLOW" }],
    });
    for (const stripDirectories of [
      -1,
      0.5,
      "2",
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        (
          await f.request(`/api/storage-sources/${src.id}/import`, "POST", {
            publicPrefix: "/legacy/",
            mimeTypes: ["image/png"],
            stripDirectories,
          })
        ).status,
      ).toBe(400);
    }
    await f.restart();
    expect(await scan(f, src.id, options)).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    await f.request(`/api/files/${file.id}`, "DELETE");
    await f.app.files.sweep();
    expect(await Bun.file(join(root, "ab/cd/photo.png")).exists()).toBe(false);
    expect(await Bun.file(join(root, "xy/zz/photo.png")).exists()).toBe(true);
  } finally {
    await f.close();
  }
});

test("WebDAV generic MIME falls back to the filename while explicit non-image MIME stays excluded", async () => {
  const remote = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      expect(req.method).toBe("PROPFIND");
      const entries = [
        ["photo.png", "Application/Octet-Stream; charset=utf-8"],
        ["notes.png", "text/plain"],
      ]
        .map(
          ([name, mime]) =>
            `<response><href>/dav/${name}</href><propstat><prop><resourcetype/><getcontenttype>${mime}</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
        .join("");
      return new Response(
        `<multistatus xmlns="DAV:">${entries}</multistatus>`,
        { status: 207 },
      );
    },
  });
  const f = await fixture();
  try {
    const src = await f.app.plugins.save({
      pluginId: "builtin.webdav",
      version: "1.0.0",
      name: "Legacy WebDAV",
      config: {
        keyPrefix: "",
        timeoutMs: 30000,
        endpoint: remote.url.href + "dav/",
      },
      secretEdits: {
        "/username": { action: "replace", value: "test" },
        "/password": { action: "replace", value: "test" },
      },
    });
    expect(await scan(f, src.id)).toMatchObject({
      imported: 1,
      skipped: 1,
      failed: 0,
    });
    expect(await scan(f, src.id, { publicPrefix: "/other/" })).toMatchObject({
      imported: 0,
      skipped: 2,
    });
    const files = await f.app.db.read((r) => r.files(10, 0));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      storage_key: "photo.png",
      mime_type: null,
    });
  } finally {
    await f.close();
    remote.stop(true);
  }
});
