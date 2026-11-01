import { expect, spyOn, test } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
import type { PostSavePlugin, StoragePlugin } from "../src/plugins/api";
import type { ConfiguredStep } from "../shared/config";
import { entity } from "../src/persistence/port";
import { basename } from "node:path";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function configure(
  f: Fixture,
  processors: Array<PostSavePlugin["process"] | ConfiguredStep>,
) {
  const steps = processors.map((process, index) => {
    if (typeof process !== "function") return process;
    const pluginId = `test.saved-content-${index}`;
    f.app.plugins.register({
      id: pluginId,
      version: "1",
      apiVersion: 1,
      kind: "processor",
      defaultLocale: "en-US",
      nameKey: "name",
      messages: { "en-US": { name: pluginId } },
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return { process };
          },
        },
      },
    });
    return { pluginId, version: "1", config: {} };
  });
  const chain = await f.app.configuration.savePipeline({
    name: "Replace saved content",
    kind: "post_save",
    steps,
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
}
async function image(width: number, format: "png" | "webp" = "png") {
  return sharp({ create: { width, height: 8, channels: 3, background: "red" } })
    .toFormat(format)
    .toBuffer();
}
const replace =
  (bytes: Uint8Array): PostSavePlugin["process"] =>
  async (input) => {
    const output = await input.createOutput();
    await output.write(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream());
    return { status: "replace", output };
  };
async function stored(f: Fixture, url: string) {
  const response = await f.request(new URL(url).pathname);
  expect(response.status).toBe(200);
  return sharp(Buffer.from(await response.arrayBuffer())).metadata();
}
async function action(f: Fixture, id: string) {
  return (await f.app.db.read((r) => r.tasks(id))).find(
    (task) => task.kind === "action",
  )!;
}

test("post-save steps consume replacements and publish only the final content at the existing URL", async () => {
  let paused = false;
  const f = await fixture({
    afterWrite: async () => {
      if (paused) return;
      paused = true;
      await f.app.files.tasks.pause();
    },
  });
  try {
    const first = await image(24),
      final = await image(12, "webp");
    let observed = 0;
    await configure(f, [
      replace(first),
      async (input) => {
        expect(input.file.metadata).toMatchObject({
          width: 24,
          mimeType: "image/png",
        });
        expect(
          (
            await sharp(
              Buffer.from(
                await new Response(await input.file.openRead()).arrayBuffer(),
              ),
            ).metadata()
          ).width,
        ).toBe(24);
        expect(input.previousResults.map((result) => result.status)).toEqual([
          "replace",
        ]);
        expect(input.currentDisposition).toBe("pass");
        observed++;
        return replace(final)(input, {} as never);
      },
    ]);
    const upload = await f.upload();
    expect(upload.status).toBe(201);
    const saved = await upload.json();
    const original = (await f.app.db.read((r) => r.file(saved.id)))!;
    expect((await stored(f, saved.url)).width).toBe(40);
    f.app.files.tasks.resume();
    await f.app.files.sweep();
    const current = await f.app.files.find(new URL(saved.url).pathname);
    expect(current.id).not.toBe(original.id);
    expect(current.logical_key).toBe(original.logical_key);
    expect(current.storage_key).not.toBe(original.storage_key);
    expect(current.mime_type).toBe("image/webp");
    expect(current.width).toBe(12);
    expect((await stored(f, saved.url)).format).toBe("webp");
    expect(await f.app.db.read((r) => r.file(original.id))).toBeNull();
    expect((await action(f, current.id)).status).toBe("success");
    const resolved = await f.request(
      `/api/files/by-path?path=${encodeURIComponent(new URL(saved.url).pathname)}`,
    );
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).id).toBe(current.id);
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(observed).toBe(1);
  } finally {
    await f.close();
  }
});

test("failed processing preserves accepted moderation and summaries without publishing intermediate replacements", async () => {
  const f = await fixture();
  try {
    f.app.config.retryLimit = 1;
    await configure(f, [
      async () => ({ status: "block", details: { reason: "review" } }),
      replace(await image(12)),
      async (input) => {
        expect(input.currentDisposition).toBe("block");
        expect(input.file.metadata.width).toBe(12);
        throw new Error("Later step failed");
      },
    ]);
    const uploaded = await (await f.upload()).json();
    await f.app.files.sweep();
    const file = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    expect(file.status).toBe("blocked");
    expect(file.width).toBe(40);
    expect(
      file.processing_results_json?.map((result) => result.status),
    ).toEqual(["block", "replace"]);
    expect((await action(f, file.id)).status).toBe("failed");
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    await f.close();
  }
});

test("failed replacement writes retain the original and a retry after restart reruns processing and notifications", async () => {
  let paused = false;
  const f = await fixture({
    afterWrite: async () => {
      if (paused) return;
      paused = true;
      await f.app.files.tasks.pause();
    },
  });
  let notifications = 0;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    notifications++;
    return Response.json({ ok: true, result: { message_id: notifications } });
  }) as unknown as typeof fetch);
  try {
    f.app.config.retryLimit = 1;
    await configure(f, [
      {
        pluginId: "builtin.sharp",
        version: "1.0.0",
        config: { w: 18, format: "webp" },
      },
      {
        pluginId: "builtin.telegram-notification",
        version: "1.0.0",
        config: {
          statuses: ["pass"],
          chatId: "-100123",
          includeDetails: false,
          timeoutMs: 1000,
        },
        secretEdits: {
          "/botToken": { action: "replace", value: "123:test-token" },
        },
      },
    ]);
    const uploaded = await (await f.upload()).json();
    const replica = (await f.app.db.read((r) => r.replicas(uploaded.id)))[0]!;
    const lease = f.app.plugins.acquire(replica.storage_instance_id, "storage");
    const runtime = lease.runtime as StoragePlugin;
    const originalWrite = runtime.write.bind(runtime);
    const write = spyOn(runtime, "write").mockImplementation(
      async (input, ctx) => {
        if (input.storageKey.startsWith(".picloom-replacement/"))
          throw new Error("Storage unavailable");
        return originalWrite(input, ctx);
      },
    );
    await lease.release();
    f.app.files.tasks.resume();
    await f.app.files.sweep();
    const failed = await action(f, uploaded.id);
    expect(failed.status).toBe("failed");
    expect((await stored(f, uploaded.url)).width).toBe(40);
    expect(notifications).toBe(1);
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(
      await f.app.db.read((r) => r.filesInStates(["preparing"])),
    ).toHaveLength(0);
    write.mockRestore();
    await f.restart();
    await f.app.files.tasks.retry(failed.id);
    await f.app.files.sweep();
    const current = await f.app.files.find(new URL(uploaded.url).pathname);
    expect(current.id).not.toBe(uploaded.id);
    expect((await stored(f, uploaded.url)).width).toBe(18);
    expect((await action(f, current.id)).status).toBe("success");
    expect(notifications).toBe(2);
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});

for (const invalid of ["image", "dimensions", "bytes", "ownership"] as const) {
  test(`post-save rejects invalid replacement ${invalid} without changing current content`, async () => {
    const f = await fixture();
    try {
      f.app.config.retryLimit = 1;
      f.app.config.maxDimension = 60;
      await configure(f, [
        async (input) => {
          if (invalid === "ownership")
            return { status: "replace", output: { handle: "forged" } } as never;
          const output = await input.createOutput();
          const bytes =
            invalid === "image"
              ? Buffer.from("invalid")
              : invalid === "dimensions"
                ? await image(80)
                : Buffer.alloc(f.app.config.maxUploadBytes + 1);
          await output.write(new Blob([new Uint8Array(bytes)]).stream());
          return { status: "replace", output };
        },
      ]);
      const uploaded = await (await f.upload()).json();
      await f.app.files.sweep();
      const file = (await f.app.db.read((r) => r.file(uploaded.id)))!;
      expect(file.width).toBe(40);
      expect((await action(f, file.id)).status).toBe("failed");
      expect(f.app.files.temporary.bytes).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("one replacement replica publishes while failed copies repair from the new content and old readers retain their source", async () => {
  let paused = false;
  const f = await fixture({
    afterWrite: async () => {
      if (paused) return;
      paused = true;
      await f.app.files.tasks.pause();
    },
  });
  let reader: Response | undefined;
  try {
    f.app.config.writeConcurrency = 1;
    f.app.config.retryLimit = 1;
    const second = await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Second copy",
      config: { root: `${f.root}/second` },
    });
    const profile = await f.app.configuration.profile(f.profileId);
    const group = await f.app.configuration.group(profile.storageGroupId);
    await f.app.configuration.saveGroup(
      {
        ...group,
        expectedVersion: group.configVersion,
        replicaCount: 2,
        members: [...group.members, { instanceId: second.id, weight: 1 }],
      },
      group.id,
    );
    let processes = 0;
    const bytes = await image(17, "webp");
    await configure(f, [
      async (input, ctx) => {
        processes++;
        return replace(bytes)(input, ctx);
      },
    ]);
    const uploaded = await (await f.upload()).json();
    const original = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    reader = await f.app.files.preview(
      uploaded.id,
      new AbortController().signal,
    );
    const lease = f.app.plugins.acquire(second.id, "storage");
    const runtime = lease.runtime as StoragePlugin;
    const originalWrite = runtime.write.bind(runtime);
    const write = spyOn(runtime, "write").mockImplementation(
      async (input, ctx) => {
        if (input.storageKey.startsWith(".picloom-replacement/"))
          throw new Error("Second copy unavailable");
        return originalWrite(input, ctx);
      },
    );
    await lease.release();
    f.app.files.tasks.resume();
    await f.app.files.tasks.drain();
    const current = await f.app.files.find(new URL(uploaded.url).pathname);
    expect(current.id).not.toBe(original.id);
    expect((await action(f, current.id)).status).toBe("success");
    expect((await stored(f, uploaded.url)).width).toBe(17);
    const candidateReplicas = await f.app.db.read((r) =>
      r.replicas(current.id),
    );
    expect(candidateReplicas.map((replica) => replica.status).sort()).toEqual([
      "ready",
      "write_failed",
    ]);
    let cleaned = false;
    const cleanup = f.app.files.tasks.sweep().then(() => {
      cleaned = true;
    });
    await Bun.sleep(10);
    expect(cleaned).toBe(false);
    expect(
      (await f.app.db.read((r) => r.replicas(original.id))).every(
        (replica) => replica.status === "ready",
      ),
    ).toBe(true);
    expect(
      (await sharp(Buffer.from(await reader.arrayBuffer())).metadata()).width,
    ).toBe(40);
    reader = undefined;
    await cleanup;
    expect(
      (await f.app.db.read((r) => r.replicas(original.id))).every(
        (replica) => replica.status === "deleted",
      ),
    ).toBe(true);
    expect(f.app.files.temporary.bytes).toBe(0);
    write.mockRestore();
    const failedWrite = (await f.app.db.read((r) => r.tasks(current.id))).find(
      (task) => task.kind === "write" && task.status === "failed",
    )!;
    await f.app.files.tasks.retry(failedWrite.id);
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.replicas(current.id))).every(
        (replica) => replica.status === "ready",
      ),
    ).toBe(true);
    expect(processes).toBe(1);
  } finally {
    await reader?.body?.cancel();
    await f.close();
  }
});

for (const decision of ["block", "delete"] as const) {
  test(`post-save ${decision} is retained when the chain also replaces content`, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      let tagId = "";
      await configure(f, [
        async (_input, context) => {
          calls++;
          tagId = (await context.organization.ensureTag({ name: "Reviewed" }))
            .id;
          return { status: decision, organization: { tagIds: [tagId] } };
        },
        replace(await image(14, "webp")),
      ]);
      const uploaded = await (await f.upload()).json();
      await f.app.files.sweep();
      expect(calls).toBe(1);
      expect(await f.app.db.read((r) => r.file(uploaded.id))).toBeNull();
      if (decision === "delete") {
        expect(await f.app.db.read((r) => r.countFiles())).toBe(0);
      } else {
        const current = await f.app.files.find(new URL(uploaded.url).pathname);
        expect(current.status).toBe("blocked");
        expect(current.width).toBe(14);
        expect(
          current.processing_results_json?.map((result) => result.status),
        ).toEqual(["block", "replace"]);
        expect((await action(f, current.id)).status).toBe("success");
        expect(
          (await f.app.db.read((r) => r.fileTags([current.id])))
            .get(current.id)
            ?.map((tag) => tag.id),
        ).toEqual([tagId]);
        expect((await f.request(new URL(uploaded.url).pathname)).status).toBe(
          404,
        );
      }
      expect(f.app.files.temporary.bytes).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("manual replacement resolves the new record after post-save processing", async () => {
  const f = await fixture();
  try {
    await configure(f, [
      {
        pluginId: "builtin.sharp",
        version: "1.0.0",
        config: { w: 18, format: "webp" },
      },
    ]);
    const oldUpload = await (await f.upload()).json();
    const nextUpload = await (await f.upload()).json();
    await f.app.files.sweep();
    const old = await f.app.files.find(new URL(oldUpload.url).pathname);
    const path = new URL(nextUpload.url).pathname;
    const resolved = await f.request(
      `/api/files/by-path?path=${encodeURIComponent(path)}`,
    );
    const next = await resolved.json();
    expect(next.id).not.toBe(nextUpload.id);
    expect(next.backgroundPending).toBe(false);
    const replaced = await f.request(`/api/files/${old.id}/replace`, "POST", {
      replacementId: next.id,
      replacementPath: path,
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ id: next.id, url: oldUpload.url });
    await f.app.files.sweep();
    expect((await stored(f, oldUpload.url)).width).toBe(18);
  } finally {
    await f.close();
  }
});

test("restart discards an unfinished candidate and retries the original processing task", async () => {
  let paused = false;
  const f = await fixture({
    afterWrite: async () => {
      if (paused) return;
      paused = true;
      await f.app.files.tasks.pause();
    },
  });
  try {
    await configure(f, [
      {
        pluginId: "builtin.sharp",
        version: "1.0.0",
        config: { w: 18, format: "webp" },
      },
    ]);
    const uploaded = await (await f.upload()).json();
    const original = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    const path = f.app.files.temporary.create();
    await f.app.files.temporary.write(
      path,
      new Blob([new Uint8Array(f.png)]).stream(),
      f.app.config.maxUploadBytes,
    );
    const candidate = {
      ...original,
      ...entity(),
      logical_key: `.replacements/${crypto.randomUUID()}`,
      storage_key: `abandoned/${crypto.randomUUID()}`,
      status: "preparing" as const,
      temp_path: basename(path),
    };
    const task = await action(f, original.id);
    await f.app.db.transaction(async (r) => {
      await r.insertFile(candidate);
      const target = (await r.replicas(original.id))[0]!;
      const replica = {
        ...entity(),
        file_id: candidate.id,
        storage_instance_id: target.storage_instance_id,
        status: "pending" as const,
        locator_json: null,
      };
      await r.insertReplica(replica);
      await r.insertTask({
        ...entity(),
        kind: "write",
        file_id: candidate.id,
        replica_id: replica.id,
        pipeline_id: null,
        status: "pending",
        attempts: 0,
        next_run_at: Date.now(),
        last_error: null,
      });
      task.status = "running";
      task.attempts = 1;
      await r.saveTask(task, "pending");
    });
    await f.restart();
    const current = await f.app.files.find(new URL(uploaded.url).pathname);
    expect(current.id).not.toBe(original.id);
    expect(current.width).toBe(18);
    expect(await f.app.db.read((r) => r.file(candidate.id))).toBeNull();
    expect(await f.app.db.read((r) => r.task(task.id))).toMatchObject({
      file_id: current.id,
      status: "success",
      attempts: 2,
    });
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    await f.close();
  }
});
