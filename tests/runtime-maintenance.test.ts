import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/runtime";

test("a blocked task sweep and failing cache maintenance do not block other cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-maintenance-"));
  const runtime = await startRuntime(
    {
      root,
      databaseUrl: "",
      encryptionKey: "ab".repeat(32),
      origin: "http://localhost",
      secureCookie: false,
    },
    { initialPassword: "test-password-123", log: () => {} },
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sweep = spyOn(runtime.app.files, "sweep").mockImplementation(
    () => blocked,
  );
  const cache = spyOn(runtime.app.files.cache, "clean").mockRejectedValue(
    new Error("Unavailable"),
  );
  const temporary = spyOn(
    runtime.app.files.temporary,
    "clean",
  ).mockResolvedValue();
  const uploads = spyOn(runtime.app.uploads, "cleanup").mockResolvedValue();
  try {
    const deadline = Date.now() + 4800;
    while (uploads.mock.calls.length < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(cache.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(temporary.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(uploads.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await runtime.close();
    sweep.mockRestore();
    cache.mockRestore();
    temporary.mockRestore();
    uploads.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
