import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { directoryBytes, localUsage } from "../src/infra/disk-usage";
import { entity } from "../src/persistence/port";

test("directory sizes deduplicate roots, nesting and hard links; exclude symlinks and report unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "star-disk-"));
  try {
    const nested = join(root, "nested"),
      other = join(root, "other");
    await mkdir(nested);
    await mkdir(other);
    await Bun.write(join(nested, "a"), "abc");
    await link(join(nested, "a"), join(nested, "b"));
    await Bun.write(join(other, "x"), "12345");
    await symlink(other, join(nested, "outside"));
    expect(await directoryBytes([root, nested, root])).toBe(8);
    expect(await directoryBytes([nested])).toBe(3);
    expect(await directoryBytes([root], [other])).toBe(3);
    expect(await directoryBytes([join(root, "missing")])).toBeNull();
    await mkdir(join(root, "temp"));
    await mkdir(join(root, "cache"));
    const usage = await localUsage(root, [join(root, "missing")]);
    expect(usage.originals).toBeNull();
    expect(usage.temporary).toBe(0);
    expect(usage.cache).toBe(0);
    expect(usage.diskTotal).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system status is admin-only, counts images and tasks, caches local usage including external roots", async () => {
  const f = await fixture();
  const external = await mkdtemp(join(tmpdir(), "star-external-"));
  try {
    expect(
      (await handler(f.app)(new Request("http://localhost/api/system/status")))
        .status,
    ).toBe(401);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request("/api/system/status", "GET", undefined, token.token))
        .status,
    ).toBe(403);
    const upload = await (await f.upload()).json();
    await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "External",
      config: { root: external },
    });
    await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Same external",
      config: { root: external },
    });
    await Bun.write(join(external, "data"), new Uint8Array(10000));
    const pipeline = {
      ...entity(),
      name: "Post-save",
      kind: "post_save" as const,
      config_version: 1,
    };
    await f.app.db.transaction((r) => r.insertPipeline(pipeline));
    await f.app.db.transaction((r) =>
      r.insertTask({
        ...entity(),
        kind: "action",
        file_id: upload.id,
        replica_id: null,
        pipeline_id: pipeline.id,
        status: "failed",
        attempts: 1,
        next_run_at: null,
        last_error: "secret=/private/path",
      }),
    );
    let status = await (await f.request("/api/system/status")).json();
    expect(status.local.calculating).toBe(true);
    for (let i = 0; i < 100 && status.local.calculating; i++) {
      await Bun.sleep(10);
      status = await (await f.request("/api/system/status")).json();
    }
    expect(status.local.calculating).toBe(false);
    expect(status.readyFiles).toBe(1);
    expect(status.originalBytes).toBe(f.png.byteLength);
    expect(status.failedTasks).toBe(1);
    expect(status.failures[0].error).toBe("TASK_FAILED");
    expect(status.local.originals).toBeGreaterThan(10000);
    expect(status.local.originals).toBeLessThan(20000);
    expect(status.local.diskTotal).toBeGreaterThan(0);
    expect(status.local.diskAvailable).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(external);
    await Bun.write(join(external, "later"), new Uint8Array(10000));
    const again = await (await f.request("/api/system/status")).json();
    expect(again.local.measuredAt).toBe(status.local.measuredAt);
    expect(again.local.originals).toBe(status.local.originals);
  } finally {
    await f.close();
    await rm(external, { recursive: true, force: true });
  }
});

test("missing storage definitions only make original usage unknown, including cached measurements", async () => {
  const f = await fixture();
  try {
    await f.upload();
    await f.app.system.get();
    await f.app.system.close(); // Wait for the background measurement.
    expect((await f.app.system.get()).local.originals).not.toBeNull();
    const missing = await f.app.db.transaction(async (r) => {
      const record = (await r.instances()).find((i) => i.kind === "storage")!;
      const next = {
        ...record,
        plugin_id: "test.missing-storage",
        config_version: record.config_version + 1,
      };
      await r.saveInstance(next, record.config_version);
      return next;
    });
    // Directory discovery remains strict for backup callers.
    expect(() => f.app.plugins.localDirectory(missing)).toThrow(
      "Plugin is not loaded",
    );
    const cached = await f.request("/api/system/status");
    expect(cached.status).toBe(200);
    expect((await cached.json()).local.originals).toBeNull();
    await f.app.system.invalidateUsage();
    await f.app.system.get();
    await f.app.system.close();
    const status = await (await f.request("/api/system/status")).json();
    expect(status.readyFiles).toBe(1);
    expect(status.local.originals).toBeNull();
    expect(status.local.calculating).toBe(false);
    expect(status.local.diskTotal).toBeGreaterThan(0);
    expect(status.local.temporary).not.toBeNull();
    expect(status.local.cache).not.toBeNull();
  } finally {
    await f.close();
  }
});
