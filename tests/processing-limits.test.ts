import { test, expect, spyOn } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("upload limits leave historical originals, cached and uncached transforms readable", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    const path = new URL(uploaded.url).pathname;
    for (const route of [
      path + "?w=20",
      `/api/files/${uploaded.id}/thumbnail`,
    ]) {
      const response = await f.request(route);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const settings = await (await f.request("/api/settings")).json();
    await f.request("/api/settings", "PUT", { ...settings, maxUploadBytes: 1 });
    for (const clear of [false, true]) {
      if (clear) await f.app.files.cache.clear();
      for (const route of [
        path,
        path + "?w=20",
        `/api/files/${uploaded.id}/thumbnail`,
      ]) {
        const response = await f.request(route);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    }
    expect((await f.upload()).status).toBe(413);
    const schema = await (
      await f.request("/api/plugins/builtin.sharp/versions/1.0.0")
    ).json();
    expect(
      schema.stages.upload.configSchema.properties.maxPixels,
    ).toBeUndefined();
    expect(
      schema.stages.access.configSchema.properties.maxPixels,
    ).toBeUndefined();
    await f.request("/api/settings", "PUT", { ...settings, maxPixels: 1 });
    expect((await f.request(path + "?w=20")).status).not.toBe(200);
    await f.request("/api/settings", "PUT", {
      ...settings,
      maxPixels: 80000000,
    });
    const response = await f.request(path + "?w=20");
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const chain = await f.app.configuration.savePipeline({
      name: "PNG encoding",
      kind: "upload",
      steps: [
        {
          pluginId: "builtin.sharp",
          version: "1.0.0",
          config: { format: "png" },
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
    const webp = await sharp(f.png).webp().toBuffer();
    await f.request("/api/settings", "PUT", {
      ...settings,
      maxUploadBytes: webp.length,
    });
    expect((await f.upload(undefined, webp, "image.webp")).status).toBe(413);
  } finally {
    await f.close();
  }
});

test("upload processing shares the thumbnail/access concurrency and queue limit", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred(),
    queued = deferred();
  let pipelineSpy: ReturnType<typeof spyOn> | undefined,
    limiterSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const original = await (await f.upload()).json();
    f.app.files.configureProcessing(1, 1);
    const files = f.app.files as any;
    const pipeline = files.pipeline.bind(files);
    pipelineSpy = spyOn(files, "pipeline").mockImplementation(
      async (...args: any[]) => {
        entered.resolve();
        await release.promise;
        return pipeline(...args);
      },
    );
    const upload = f.upload();
    await entered.promise;
    const run = files.limit.run.bind(files.limit);
    limiterSpy = spyOn(files.limit, "run").mockImplementation(
      (fn: any, signal?: AbortSignal) => {
        const result = run(fn, signal);
        queued.resolve();
        return result;
      },
    );
    const thumb = f.request(`/api/files/${original.id}/thumbnail`);
    await queued.promise;
    expect(
      (await f.request(new URL(original.url).pathname + "?w=20")).status,
    ).toBe(503);
    release.resolve();
    expect((await upload).status).toBe(201);
    const result = await thumb;
    expect(result.status).toBe(200);
    await result.arrayBuffer();
  } finally {
    release.resolve();
    pipelineSpy?.mockRestore();
    limiterSpy?.mockRestore();
    await f.close();
  }
});

test("different parts stream concurrently; duplicate parts serialize and completion/cancellation wait", async () => {
  const f = await fixture();
  const gates: ReturnType<typeof deferred>[] = [];
  try {
    f.app.config.chunkPartBytes = Math.ceil(f.png.length / 2);
    // Two distinct parts plus one queued replacement.
    f.app.config.partConcurrency = 3;
    const create = async () =>
      (
        await f.request("/api/uploads", "POST", {
          profileId: f.profileId,
          size: f.png.length,
        })
      ).json();
    const handle = handler(f.app);
    function part(
      id: string,
      index: number,
      bytes: Uint8Array,
      gate?: ReturnType<typeof deferred>,
      started?: ReturnType<typeof deferred>,
    ) {
      return handle(
        new Request(`http://localhost/api/uploads/${id}/parts/${index}`, {
          method: "PUT",
          headers: { "x-upload-key": f.uploadKeys.get(id)! },
          body: new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                started?.resolve();
                if (gate) await gate.promise;
                controller.enqueue(bytes);
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        }),
      );
    }
    const session = await create();
    const firstStarted = deferred(),
      firstGate = deferred(),
      duplicateStarted = deferred(),
      duplicateGate = deferred();
    gates.push(firstGate, duplicateGate);
    let duplicateReading = false;
    void duplicateStarted.promise.then(() => {
      duplicateReading = true;
    });
    const first = part(
      session.id,
      0,
      f.png.subarray(0, session.partSize),
      firstGate,
      firstStarted,
    );
    await firstStarted.promise;
    const duplicate = part(
      session.id,
      0,
      f.png.subarray(0, session.partSize),
      duplicateGate,
      duplicateStarted,
    );
    const second = await part(session.id, 1, f.png.subarray(session.partSize));
    expect(second.status).toBe(200);
    expect(duplicateReading).toBe(false);
    let completeEnded = false;
    const complete = f
      .request(`/api/uploads/${session.id}/complete`, "POST")
      .then((r) => {
        completeEnded = true;
        return r;
      });
    expect(completeEnded).toBe(false);
    firstGate.resolve();
    expect((await first).status).toBe(200);
    await duplicateStarted.promise;
    expect(completeEnded).toBe(false);
    duplicateGate.resolve();
    expect((await duplicate).status).toBe(200);
    expect((await complete).status).toBe(200);
    const cancelled = await create(),
      cancelStarted = deferred(),
      cancelGate = deferred();
    gates.push(cancelGate);
    const writing = part(
      cancelled.id,
      0,
      f.png.subarray(0, cancelled.partSize),
      cancelGate,
      cancelStarted,
    );
    await cancelStarted.promise;
    const cancel = f.request(`/api/uploads/${cancelled.id}`, "DELETE");
    cancelGate.resolve();
    expect((await writing).status).toBe(200);
    expect((await cancel).status).toBe(200);
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
  } finally {
    for (const gate of gates) gate.resolve();
    await f.close();
  }
});

test("cancelling an upload waiting for processing releases its temporary allocation before active work finishes", async () => {
  const f = await fixture();
  const release = deferred(),
    queued = deferred();
  const files = f.app.files as any;
  f.app.files.configureProcessing(1, 1);
  const active = files.limit.run(() => release.promise);
  const run = files.limit.run.bind(files.limit);
  const spy = spyOn(files.limit, "run").mockImplementation(
    (fn: any, signal?: AbortSignal) => {
      const result = run(fn, signal);
      queued.resolve();
      return result;
    },
  );
  let upload: Promise<Response> | undefined;
  const controller = new AbortController();
  try {
    const form = new FormData();
    form.set("profileId", f.profileId);
    form.set("file", new File([new Uint8Array(f.png)], "queued.png"));
    upload = handler(f.app)(
      new Request("http://localhost/api/files", {
        method: "POST",
        headers: { cookie: f.cookie, "x-csrf-token": f.csrf },
        body: form,
        signal: controller.signal,
      }),
    );
    await queued.promise;
    expect(f.app.files.temporary.bytes).toBeGreaterThan(0);
    controller.abort();
    expect((await upload).ok).toBe(false);
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    controller.abort();
    release.resolve();
    await active;
    await upload;
    spy.mockRestore();
    await f.close();
  }
});
