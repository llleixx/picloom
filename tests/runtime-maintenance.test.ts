import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/runtime";
import { fixture } from "./helpers";
import { localStorage } from "../src/builtins/storage/local";

test("restart serves requests while persisted deletion runs in the background", async () => {
  const f = await fixture();
  const originalCreate = localStorage.createInstance;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let starting: ReturnType<typeof startRuntime> | undefined;
  let create: ReturnType<typeof spyOn> | undefined;
  try {
    const removed = await (await f.upload()).json();
    await f.app.files.sweep();
    await f.app.files.tasks.pause();
    await f.app.files.delete(removed.id);
    await f.app.close();
    create = spyOn(localStorage, "createInstance").mockImplementation(
      async (input) => {
        const storage = await originalCreate(input);
        const remove = storage.delete.bind(storage);
        return {
          ...storage,
          async delete(input, ctx) {
            entered();
            await blocked;
            return remove(input, ctx);
          },
        };
      },
    );
    starting = startRuntime(f.overrides);
    const first = await Promise.race([
      starting.then((value) => {
        runtime = value;
        return "started";
      }),
      deleting.then(() => "deleting"),
    ]);
    expect(first).toBe("started");
    // The normal runtime timer must resume persisted work without an explicit sweep.
    await deleting;
    const response = await runtime!.fetch(
      new Request("http://localhost/api/client-settings"),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    release();
    await runtime!.app.files.sweep();
    expect(await runtime!.app.db.read((r) => r.file(removed.id))).toBeNull();
  } finally {
    release();
    if (starting) runtime = await starting;
    await runtime?.close();
    create?.mockRestore();
    await f.close();
  }
}, 10000);

test("a blocked recovery sweep and failing cache maintenance do not block other cleanup", async () => {
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
  const sweep = spyOn(
    runtime.app.files.tasks,
    "cleanupPending",
  ).mockImplementation(() => blocked);
  const dispatch = spyOn(runtime.app.files.tasks, "dispatch").mockResolvedValue(
    [],
  );
  const cache = spyOn(runtime.app.files.cache, "clean").mockRejectedValue(
    new Error("Unavailable"),
  );
  const temporary = spyOn(
    runtime.app.files.temporary,
    "clean",
  ).mockResolvedValue();
  const uploads = spyOn(runtime.app.uploads, "cleanup").mockResolvedValue();
  const packages = spyOn(runtime.app.packages, "cleanup").mockResolvedValue();
  try {
    const deadline = Date.now() + 4800;
    const independentJobs = [dispatch, cache, temporary, uploads, packages];
    while (
      independentJobs.some((job) => job.mock.calls.length < 2) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cache.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(temporary.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(uploads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(packages.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await runtime.close();
    sweep.mockRestore();
    dispatch.mockRestore();
    cache.mockRestore();
    temporary.mockRestore();
    uploads.mockRestore();
    packages.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
