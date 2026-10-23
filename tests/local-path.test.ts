import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStorage } from "../src/builtins/storage/local/index";
import type { InstanceServices } from "../src/plugins/api";

test("local storage uses storageKey, retries its own write and preserves conflicting objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-path-"));
  const ctx = {
    signal: new AbortController().signal,
    requestId: "test",
    log() {},
  };
  const create = () =>
    localStorage.createInstance({
      id: "test",
      config: { root },
      services: {} as InstanceServices,
    });
  const input = {
    operationId: "op",
    fileId: crypto.randomUUID(),
    storageKey: "中文/nested/a.png",
    file: {
      metadata: {
        byteSize: 4,
        mimeType: "image/png",
        width: null,
        height: null,
      },
      async openRead() {
        return new Blob(["data"]).stream();
      },
    },
  };
  try {
    let plugin = await create();
    expect(await plugin.write(input, ctx)).toEqual({
      locator: { key: input.storageKey },
    });
    expect(await Bun.file(join(root, input.storageKey)).text()).toBe("data");
    plugin = await create();
    expect(await plugin.write(input, ctx)).toEqual({
      locator: { key: input.storageKey },
    });
    await expect(
      plugin.write(
        { ...input, operationId: "other", fileId: crypto.randomUUID() },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await Bun.write(join(root, "existing.png"), "keep");
    await expect(
      plugin.write({ ...input, storageKey: "existing.png" }, ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await Bun.file(join(root, "existing.png")).text()).toBe("keep");
    const page = await plugin.listFiles!({ limit: 100 }, ctx);
    expect(page.items.map((x) => x.storageKey).sort()).toEqual(
      ["existing.png", input.storageKey].sort(),
    );
    await expect(
      plugin.delete({ ...input, locator: null }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
    expect(await Bun.file(join(root, input.storageKey)).text()).toBe("data");
    for (const item of page.items)
      expect(item.locator).toEqual({ key: item.storageKey });
    const imported = page.items.find(
      (item) => item.storageKey === input.storageKey,
    )!;
    await plugin.delete({ ...input, locator: imported.locator! }, ctx);
    await plugin.delete({ ...input, locator: imported.locator! }, ctx);
    expect(await Bun.file(join(root, input.storageKey)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
