import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TemporarySpace } from "../src/infra/temporary-space";
import type { Settings } from "../src/config";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { ImageCache } from "../src/core/cache";
import { PluginError } from "@picloom/plugin-sdk";
const bytes = (size: number) => new Blob([new Uint8Array(size)]).stream();

test("temporary writes enforce shared budget before disk writes and release failed/cancelled allocations", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-budget-"));
  const config = {
    root,
    uploadTempBytes: 10,
    uploadConcurrency: 2,
  } as Settings;
  const space = new TemporarySpace(config);
  try {
    await space.recover();
    const a = space.create(6);
    await space.write(a, bytes(6), 100);
    const b = space.create();
    await expect(space.write(b, bytes(5), 100)).rejects.toMatchObject({
      code: "TEMP_CAPACITY",
    });
    expect(space.bytes).toBe(6);
    expect(await Bun.file(b).exists()).toBe(false);
    expect((await stat(a)).size).toBe(6);
    config.uploadTempBytes = 1;
    expect(() => space.create(1)).toThrow();
    await space.remove(a);
    expect(space.bytes).toBe(0);
    config.uploadTempBytes = 10;
    const cancelled = space.create(10);
    await expect(
      space.write(cancelled, bytes(10), 10, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(space.bytes).toBe(0);
    const kept = space.create(4);
    await space.write(kept, bytes(4), 4);
    const recovered = new TemporarySpace(config);
    await recovered.recover();
    expect(recovered.bytes).toBe(4);
    await recovered.remove(kept);
    expect(recovered.bytes).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent chunk writes stay parallel, reject excess parts and hand off the assembled inode", async () => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const requests: Promise<Response>[] = [];
  let moveSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const size = f.png.length * 2;
    f.app.config.chunkPartBytes = f.png.length;
    f.app.config.partConcurrency = 2;
    f.app.config.uploadTempBytes = 2 * size;
    const response = await f.request("/api/uploads", "POST", {
      profileId: f.profileId,
      size,
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    expect(f.app.files.temporary.bytes).toBe(2 * size);
    const send = (
      index: number,
      body: ReadableStream<Uint8Array> | Uint8Array,
    ) =>
      handler(f.app)(
        new Request(
          "http://localhost/api/uploads/" + session.id + "/parts/" + index,
          {
            method: "PUT",
            headers: { "x-upload-key": session.uploadKey },
            body: body as BodyInit,
          },
        ),
      );
    for (const index of [0, 1])
      requests.push(
        send(
          index,
          new ReadableStream({
            async start(controller) {
              await barrier;
              controller.enqueue(f.png);
              controller.close();
            },
          }),
        ),
      );
    let active = 0;
    for (let i = 0; i < 100; i++) {
      active = (
        await readdir(join(f.root, "uploads", session.id)).catch(() => [])
      ).filter((x) => x.endsWith(".tmp")).length;
      if (active === 2) break;
      await Bun.sleep(5);
    }
    expect(active).toBe(2);
    expect((await send(0, f.png)).status).toBe(503);
    release();
    expect((await Promise.all(requests)).map((x) => x.status)).toEqual([
      200, 200,
    ]);
    const take = f.app.files.temporary.takeSession.bind(f.app.files.temporary);
    let sameInode = false;
    moveSpy = spyOn(f.app.files.temporary, "takeSession").mockImplementation(
      async (key, source, size) => {
        const before = await stat(source);
        const path = await take(key, source, size);
        sameInode = (await stat(path)).ino === before.ino;
        return path;
      },
    );
    expect(
      (await f.request("/api/uploads/" + session.id + "/complete", "POST"))
        .status,
    ).toBe(200);
    expect(sameInode).toBe(true);
    await f.app.files.sweep();
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
  } finally {
    release();
    await Promise.allSettled(requests);
    moveSpy?.mockRestore();
    await f.close();
  }
});

test("automatic retries retain sources only until exhausted; pending sessions survive restart", async () => {
  const f = await fixture();
  try {
    f.app.config.retryLimit = 2;
    f.app.plugins.register({
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Retain" } },

      id: "test.keep-temp",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              async execute() {
                throw new PluginError("FAILED", "retry automatically", true);
              },
            };
          },
        },
      },
    });
    const chain = await f.app.configuration.savePipeline({
      name: "Retain input",
      kind: "post_save",
      steps: [{ pluginId: "test.keep-temp", version: "1", config: {} }],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: chain.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const uploadedResponse = await f.upload();
    expect(uploadedResponse.status).toBe(201);
    const upload = await uploadedResponse.json();
    await f.app.files.sweep();
    expect(f.app.files.temporary.bytes).toBe(f.png.length);
    const uploaded = (await f.app.db.read((r) => r.files(10, 0)))[0]!;
    const task = (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
      (t) => t.kind === "action",
    )!;
    expect(task.status).toBe("pending");
    await f.app.db.transaction(async (r) => {
      task.next_run_at = Date.now();
      await r.saveTask(task);
    });
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "failed",
    );
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(
      (await f.request("/api/tasks/" + task.id + "/retry", "POST")).status,
    ).toBe(200);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.task(task.id)))?.status).toBe(
      "failed",
    );
    expect(f.app.files.temporary.bytes).toBe(0);
    const original = await f.request(new URL(upload.url).pathname);
    // The successfully stored replica remains available after the action fails.
    expect((await f.app.db.read((r) => r.file(uploaded.id)))!.status).toBe(
      "ready",
    );
    expect(original.status).toBe(200);
    await original.arrayBuffer();
    const response = await f.request("/api/uploads", "POST", {
      profileId: f.profileId,
      size: f.png.length,
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    const before = f.app.files.temporary.bytes;
    await f.restart();
    expect(f.app.files.temporary.bytes).toBe(before);
    expect(
      (await f.request("/api/uploads/" + session.id, "DELETE")).status,
    ).toBe(200);
    expect(f.app.files.temporary.bytes).toBe(0);
    const rows = await f.app.db.read((r) => r.files(10, 0));
    const file = rows[0]!;
    expect((await f.request("/api/files/" + file.id, "DELETE")).status).toBe(
      202,
    );
    await f.app.files.sweep();
    await f.app.files.sweep();
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    await f.close();
  }
});

test("upload admission rejects full capacity before consuming multipart and releases admission slots", async () => {
  const f = await fixture();
  try {
    f.app.config.uploadConcurrency = 2;
    f.app.config.uploadTempBytes = 1;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handler(f.app)(
      new Request("http://localhost/api/files", {
        method: "POST",
        headers: {
          cookie: f.cookie,
          "x-csrf-token": f.csrf,
          "content-type": "multipart/form-data; boundary=test",
        },
        body,
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("TEMP_CAPACITY");
    expect(pulls).toBe(0);
    await body.cancel();
    f.app.config.uploadTempBytes = 1024 ** 3;
    expect((await f.upload()).status).toBe(201);
    await f.app.files.sweep();
    const leave1 = f.app.files.temporary.enterUpload();
    const leave2 = f.app.files.temporary.enterUpload();
    try {
      expect((await f.upload()).status).toBe(503);
    } finally {
      leave1();
      leave2();
    }
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    await f.close();
  }
});

test("processor output uses the same budget while the input is still retained", async () => {
  const f = await fixture();
  try {
    f.app.plugins.register({
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Large output" } },

      id: "test.large-output",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        upload: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              async check() {
                return { status: "applicable" as const };
              },
              async process({ createOutput }) {
                const output = await createOutput();
                expect("path" in output).toBe(false);
                await output.write(bytes(101));
                return { status: "replace" as const, output };
              },
            };
          },
        },
      },
    });
    const chain = await f.app.configuration.savePipeline({
      name: "Large output",
      kind: "upload",
      steps: [
        {
          pluginId: "test.large-output",
          version: "1",
          config: {},
          onNotApplicable: "abort",
        },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        uploadPipelineId: chain.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    f.app.config.uploadTempBytes = f.png.length + 100;
    const identity = await f.app.auth.authenticate(
      new Request("http://localhost", { headers: { cookie: f.cookie } }),
    );
    await expect(
      f.app.files.upload(
        new File([new Uint8Array(f.png)], "input.png"),
        f.profileId,
        identity,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "TEMP_CAPACITY" });
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("oversized and unwritable caches do not prevent serving generated images", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-cache-budget-"));
  const value = {
    bytes: new Uint8Array(2),
    metadata: { mimeType: "image/png", byteSize: 2, width: 1, height: 1 },
  };
  try {
    const cache = new ImageCache(join(root, "cache"), 1, 60000);
    await cache.put("file", "key", value);
    expect(await cache.get("file", "key")).toBeNull();
    const invalid = join(root, "not-a-directory");
    await Bun.write(invalid, "x");
    await new ImageCache(invalid, 10, 60000).put("file", "key", value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const f = await fixture();
  try {
    const item = await (await f.upload()).json();
    await f.app.files.sweep();
    f.app.files.cache.configure(1, 60000);
    const thumbnail = await f.request("/api/files/" + item.id + "/thumbnail");
    expect(thumbnail.status).toBe(200);
    expect((await thumbnail.arrayBuffer()).byteLength).toBeGreaterThan(1);
    expect(f.app.files.temporary.bytes).toBe(0);
    const cacheRoot = join(f.root, "cache");
    await rm(cacheRoot, { recursive: true, force: true });
    await Bun.write(cacheRoot, "not a directory");
    const withoutCache = await f.request(
      "/api/files/" + item.id + "/thumbnail",
    );
    expect(withoutCache.status).toBe(200);
    await withoutCache.arrayBuffer();
  } finally {
    await f.close();
  }
});

test("direct upload ceiling rejects oversized bodies with or without Content-Length", async () => {
  const f = await fixture();
  try {
    f.app.config.chunkThresholdBytes = 40 * 1024 ** 2;
    const settings = await (await f.request("/api/client-settings")).json();
    expect(settings.chunkedUpload.thresholdBytes).toBe(20 * 1024 ** 2);
    const request = (body: ReadableStream<Uint8Array>, length?: number) =>
      handler(f.app)(
        new Request("http://localhost/api/files", {
          method: "POST",
          headers: {
            cookie: f.cookie,
            "x-csrf-token": f.csrf,
            "content-type": "multipart/form-data; boundary=test",
            ...(length === undefined
              ? {}
              : { "content-length": String(length) }),
          },
          body,
        }),
      );
    let pulls = 0;
    const unread = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(1));
        },
      },
      { highWaterMark: 0 },
    );
    expect((await request(unread, 21 * 1024 ** 2)).status).toBe(413);
    expect(pulls).toBe(0);
    await unread.cancel();
    f.app.config.maxUploadBytes = 1;
    expect((await request(bytes(65538))).status).toBe(413);
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    await f.close();
  }
});

test("failed temporary deletion retains accounting and is retried independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-delete-retry-"));
  const space = new TemporarySpace({ root, uploadTempBytes: 10 } as Settings);
  try {
    await space.recover();
    const path = space.create(4);
    // A directory at a file path makes unlink fail even when tests run as root.
    await mkdir(path);
    await expect(space.remove(path)).rejects.toThrow();
    expect(space.bytes).toBe(4);
    await space.clean();
    expect(space.bytes).toBe(4);
    await rm(path, { recursive: true });
    await Bun.write(path, new Uint8Array(4));
    await space.clean();
    expect(space.bytes).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task timeout cancels execution and retains its source until the reader exits", async () => {
  const f = await fixture();
  let release!: () => void;
  let aborted!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let timer: ReturnType<typeof spyOn> | undefined;
  let sweeping: Promise<void> | undefined;
  try {
    f.app.config.retryLimit = 1;
    f.app.plugins.register({
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Timeout" } },

      id: "test.timeout",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              async execute(_input, ctx) {
                if (ctx.signal.aborted) aborted();
                else
                  ctx.signal.addEventListener("abort", aborted, { once: true });
                await finished;
                ctx.signal.throwIfAborted();
                return { status: "pass" as const };
              },
            };
          },
        },
      },
    });
    const pipeline = await f.app.configuration.savePipeline({
      name: "Timeout",
      kind: "post_save",
      steps: [{ pluginId: "test.timeout", version: "1", config: {} }],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: pipeline.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const uploaded = await (await f.upload()).json();
    const originalTimer = globalThis.setTimeout;
    timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      originalTimer(
        callback,
        delay === 120_000 ? 10 : delay,
        ...args,
      )) as typeof setTimeout);
    sweeping = f.app.files.sweep();
    await cancelled;
    expect(f.app.files.temporary.bytes).toBe(f.png.length);
    release();
    await sweeping;
    expect(
      (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
        (t) => t.kind === "action",
      )!.status,
    ).toBe("failed");
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    release();
    await sweeping;
    timer?.mockRestore();
    await f.close();
  }
});
