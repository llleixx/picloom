import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { Limiter } from "../src/core/concurrency";

test("runtime settings apply live, preserve existing upload sessions, validate and survive restart", async () => {
  const f = await fixture();
  try {
    const current = await (await f.request("/api/settings")).json();
    const first = await (
      await f.request("/api/uploads", "POST", {
        profileId: f.profileId,
        size: f.png.length,
      })
    ).json();
    const old = (await f.app.db.read((r) => r.uploadSession(first.id)))!;
    const changed = {
      ...current,
      chunkThresholdBytes: 100,
      chunkPartBytes: 64,
      uploadConcurrency: 3,
      partConcurrency: 1,
      uploadSessionTtlMs: 3600000,
      uploadTempBytes: 64 * 1024 ** 2,
      uploadSessionLimit: 10,
      maxUploadBytes: 30 * 1024 ** 2,
      maxDimension: 4096,
      maxPixels: 20000000,
      processingConcurrency: 3,
      processingQueue: 4,
      taskConcurrency: 1,
      retryLimit: 2,
    };
    expect((await f.request("/api/settings", "PUT", changed)).status).toBe(200);
    const client = await (await f.request("/api/client-settings")).json();
    expect(client.chunkedUpload).toEqual({
      thresholdBytes: 100,
      partBytes: 64,
      concurrency: 1,
    });
    expect(client.uploadConcurrency).toBe(3);
    expect(
      (await f.app.db.read((r) => r.uploadSession(first.id)))!.part_size,
    ).toBe(old.part_size);
    expect(
      (await f.app.db.read((r) => r.uploadSession(first.id)))!.expires_at,
    ).toBe(old.expires_at);
    const second = await (
      await f.request("/api/uploads", "POST", {
        profileId: f.profileId,
        size: f.png.length,
      })
    ).json();
    expect(second.partSize).toBe(64);
    expect(second.expiresAt - Date.now()).toBeGreaterThan(3590000);
    for (let index = 0; index * 64 < f.png.length; index++) {
      const response = await handler(f.app)(
        new Request(
          `http://localhost/api/uploads/${second.id}/parts/${index}`,
          {
            method: "PUT",
            headers: { "x-upload-key": second.uploadKey },
            body: new Uint8Array(f.png.subarray(index * 64, (index + 1) * 64)),
          },
        ),
      );
      expect(response.status).toBe(200);
    }
    expect(
      (await f.request(`/api/uploads/${second.id}/complete`, "POST")).status,
    ).toBe(200);
    for (const patch of [
      { partConcurrency: 0 },
      { chunkPartBytes: 65 * 1024 ** 2 },
      { uploadConcurrency: 1.5 },
      { uploadSessionTtlMs: -1 },
    ])
      expect(
        (await f.request("/api/settings", "PUT", { ...changed, ...patch }))
          .status,
      ).toBe(400);
    expect(await (await f.request("/api/settings")).json()).toEqual(changed);
    await f.restart();
    expect(await (await f.request("/api/settings")).json()).toEqual(changed);
    // Lowered limits apply to new work and do not return a previously cached transform.
    const uploaded = await (await f.upload()).json();
    const path = new URL(uploaded.url).pathname;
    const image = await f.request(path + "?w=20");
    expect(image.status).toBe(200);
    await image.arrayBuffer();
    expect(
      (
        await f.request("/api/settings", "PUT", {
          ...changed,
          maxDimension: 10,
        })
      ).status,
    ).toBe(200);
    expect((await f.request(path + "?w=20")).status).toBe(400);
    expect(
      (
        await f.request("/api/settings", "PUT", {
          ...changed,
          maxUploadBytes: f.png.length - 1,
        })
      ).status,
    ).toBe(200);
    expect((await f.upload()).status).toBe(413);
    expect((await f.upload(undefined, new Uint8Array(70000))).status).toBe(413);
    expect(
      (
        await f.request("/api/auth/login", "POST", {
          username: "x".repeat(70000),
          password: "x",
        })
      ).status,
    ).toBe(413);
  } finally {
    await f.close();
  }
});

test("changing processing concurrency preserves active work and the queue", async () => {
  const limiter = new Limiter(2, 4);
  const started: number[] = [],
    release: Array<() => void> = [];
  const jobs = [0, 1, 2, 3].map((id) =>
    limiter.run(async () => {
      started.push(id);
      await new Promise<void>((resolve) => {
        release[id] = resolve;
      });
    }),
  );
  expect(started).toEqual([0, 1]);
  limiter.configure(1, 1);
  await expect(limiter.run(async () => {})).rejects.toMatchObject({
    code: "BUSY",
  });
  release[0]!();
  await jobs[0];
  expect(started).toEqual([0, 1]);
  release[1]!();
  await jobs[1];
  expect(started).toEqual([0, 1, 2]);
  limiter.configure(3, 1);
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  release[2]!();
  release[3]!();
  await Promise.all(jobs);
});

test("internal settings save applies cache and processing settings without HTTP", async () => {
  const f = await fixture();
  const cache = spyOn(f.app.files.cache, "configure");
  const processing = spyOn(f.app.files, "configureProcessing");
  try {
    const saved = await f.app.delivery.save({
      ...f.app.delivery.get(),
      cacheBytes: 123456,
      cacheTtlMs: 60000,
      processingConcurrency: 1,
      processingQueue: 2,
    });
    expect(cache).toHaveBeenLastCalledWith(123456, 60000);
    expect(processing).toHaveBeenLastCalledWith(1, 2);
    expect(f.app.config.cacheBytes).toBe(saved.cacheBytes);
    expect(f.app.config.processingConcurrency).toBe(1);
  } finally {
    cache.mockRestore();
    processing.mockRestore();
    await f.close();
  }
});

test("cancelled queued work frees capacity and cancellation during handoff does not leak an active slot", async () => {
  const limiter = new Limiter(1, 1);
  let release!: () => void;
  const active = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    const cancelled = new AbortController();
    const queued = limiter.run(async () => {
      throw new Error("Must not execute");
    }, cancelled.signal);
    const reason = new Error("Cancelled while queued");
    cancelled.abort(reason);
    await expect(queued).rejects.toBe(reason);
    const handedOff = new AbortController();
    const replacement = limiter.run(async () => {
      throw new Error("Must not execute");
    }, handedOff.signal);
    release();
    // Wake-up resolves synchronously; execution resumes in a later microtask.
    queueMicrotask(() => handedOff.abort(reason));
    await expect(replacement).rejects.toBe(reason);
    await active;
    expect(await limiter.run(async () => "available")).toBe("available");
  } finally {
    release();
    await active;
  }
});
