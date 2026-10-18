import { test, expect } from "bun:test";
import { fixture } from "./action-fixture";
import { join } from "node:path";
import { entity } from "../src/persistence/port";
import { PluginError } from "../src/plugins/api";
import { selectStorage } from "../src/core/storage-selection";
async function actionPipeline(
  f: Awaited<ReturnType<typeof fixture>>,
  ids: string[],
) {
  const pipeline = {
    ...entity(),
    name: "Actions",
    kind: "post_save" as const,
    config_version: 1,
  };
  await f.app.db.transaction(async (r) => {
    await r.insertPipeline(pipeline);
    for (const [position, id] of ids.entries())
      await r.insertStep({
        ...entity(),
        enabled_params: [],
        pipeline_id: pipeline.id,
        position,
        plugin_instance_id: id,
        on_not_applicable: null,
      });
  });
  return pipeline.id;
}
async function payload(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function local(f: Awaited<ReturnType<typeof fixture>>, name = "Second") {
  return payload(
    await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name,
      config: { root: join(f.root, name) },
      secretEdits: {},
    }),
  );
}
async function profile(f: Awaited<ReturnType<typeof fixture>>) {
  return f.app.configuration.profile(f.profileId);
}
async function upload(
  f: Awaited<ReturnType<typeof fixture>>,
  id = f.profileId,
) {
  const form = new FormData();
  form.set("profileId", id);
  form.set("file", new File([new Uint8Array(f.png)], "a.png"));
  return payload(await f.request("/api/files", "POST", form));
}

test("historical reads use current group weights, removed members default to one and deleted groups are uniform", async () => {
  const f = await fixture();
  try {
    const p = await profile(f),
      second = await local(f),
      original = await f.app.configuration.group(p.storageGroupId);
    let group = await f.app.configuration.saveGroup(
      {
        ...original,
        members: [...original.members, { instanceId: second.id, weight: 3 }],
        redundancyCount: 1,
        expectedVersion: original.configVersion,
      },
      original.id,
    );
    const uploaded = await upload(f);
    await f.app.files.sweep();
    const record = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    expect(record.storage_group_id).toBe(group.id);
    const replicas = await f.app.db.read((r) => r.replicas(uploaded.id));
    expect(replicas.every((r) => r.status === "ready")).toBe(true);
    const selected: string[] = [];
    const leases = replicas.map((r) =>
      f.app.plugins.acquire(r.storage_instance_id, "storage"),
    );
    for (const [n, lease] of leases.entries()) {
      const read = lease.runtime.read.bind(lease.runtime);
      lease.runtime.read = async (input, ctx) => {
        selected.push(replicas[n]!.storage_instance_id);
        return read(input, ctx);
      };
    }
    const ordered = replicas.map((r) => r.storage_instance_id);
    const readAt = async (random: number) => {
      f.app.files.random = () => random;
      const response = await f.request(new URL(uploaded.url).pathname);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array(f.png),
      );
      return selected.at(-1);
    };
    // Different groups may assign different weights to the same instance.
    const other = await f.app.configuration.saveGroup({
      name: "Other",
      members: original.members.map((m) => ({ ...m, weight: 7 })),
      primaryStrategy: "priority",
      redundancyStrategy: "priority",
      redundancyCount: 0,
    });
    expect(other.members[0]!.weight).toBe(7);
    for (const bad of [0, -1, Infinity])
      await expect(
        f.app.configuration.saveGroup(
          {
            ...group,
            members: [{ instanceId: second.id, weight: bad }],
            redundancyCount: 0,
            expectedVersion: group.configVersion,
          },
          group.id,
        ),
      ).rejects.toThrow();
    group = await f.app.configuration.saveGroup(
      {
        ...group,
        members: ordered.map((instanceId, n) => ({
          instanceId,
          weight: n === 0 ? 1 : 9,
        })),
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    expect(await readAt(0.2)).toBe(ordered[1]);
    group = await f.app.configuration.saveGroup(
      {
        ...group,
        members: ordered.map((instanceId, n) => ({
          instanceId,
          weight: n === 0 ? 9 : 1,
        })),
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    expect(await readAt(0.2)).toBe(ordered[0]);
    const third = await local(f, "Third");
    group = await f.app.configuration.saveGroup(
      {
        ...group,
        members: [
          { instanceId: ordered[1]!, weight: 9 },
          { instanceId: third.id, weight: 1000 },
        ],
        redundancyCount: 0,
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    expect(await readAt(0.05)).toBe(ordered[0]); // removed historical replica: weight 1
    expect(await readAt(0.2)).toBe(ordered[1]); // newly added member has no replica
    await f.app.configuration.deleteProfile(p.id);
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))?.storage_group_id,
    ).toBe(group.id);
    await f.app.configuration.deleteGroup(group.id);
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))?.storage_group_id,
    ).toBeNull();
    expect(await readAt(0.2)).toBe(ordered[0]);
    expect(await readAt(0.8)).toBe(ordered[1]);
    for (const lease of leases) await lease.release();
    await f.restart();
    const restarted = await f.request(new URL(uploaded.url).pathname);
    expect(restarted.status).toBe(200);
    expect(new Uint8Array(await restarted.arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
  } finally {
    await f.close();
  }
});

test("configuration API enforces type, concurrency, references, prefixes and atomic chain edits", async () => {
  const f = await fixture();
  try {
    const second = await local(f),
      old = await f.app.configuration.profileEditor(f.profileId);
    const base = (await f.app.configuration.group(old.storageGroupId))
      .members[0]!;
    const group = await payload(
      await f.request("/api/storage-groups", "POST", {
        name: "Mixed",
        members: [base, { instanceId: second.id, weight: 3 }],
        primaryStrategy: "priority",
        redundancyStrategy: "weighted_random",
        redundancyCount: 1,
      }),
    );
    expect(
      (
        await f.request("/api/storage-groups/" + group.id, "PUT", {
          ...group,
          expectedVersion: 99,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request("/api/storage-groups", "POST", {
          ...group,
          members: [base, base],
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request("/api/storage-sources/" + second.id, "DELETE")).status,
    ).toBe(409);
    expect(
      (
        await f.request("/api/storage-sources/" + second.id, "PUT", {
          pluginId: "builtin.local",
          version: "1.0.0",
          name: "new",
          expectedVersion: second.configVersion,
          config: { root: join(f.root, "else") },
        })
      ).status,
    ).toBe(400);
    const changed = await payload(
      await f.request("/api/upload-profiles/" + old.id, "PUT", {
        ...old,
        storageGroupId: group.id,
        expectedVersion: old.configVersion,
      }),
    );
    expect(changed.configVersion).toBe(old.configVersion + 1);
    expect(
      (
        await f.request("/api/upload-profiles/" + old.id, "PUT", {
          ...changed,
          publicPrefix: "/app/",
          expectedVersion: changed.configVersion,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/api/upload-profiles/" + old.id, "PUT", {
          ...changed,
          uploadPipelineId: 42,
          expectedVersion: changed.configVersion,
        })
      ).status,
    ).toBe(400);
    expect((await profile(f)).configVersion).toBe(changed.configVersion);
    const access = (await payload(await f.request("/api/pipelines"))).find(
      (p: any) => p.kind === "access",
    );
    expect(
      (
        await f.request("/api/pipelines/" + access.id, "PUT", {
          ...access,
          steps: [],
          expectedVersion: -1,
        })
      ).status,
    ).toBe(409);
    await payload(
      await f.request("/api/pipelines/" + access.id, "PUT", {
        ...access,
        steps: [],
        expectedVersion: access.configVersion,
      }),
    );
    expect(
      (await payload(await f.request("/api/pipelines/" + access.id))).steps,
    ).toEqual([]);
    const token = await payload(
      await f.request("/api/tokens", "POST", { name: "only upload" }),
    );
    for (const path of [
      "/api/plugins",
      "/api/storage-sources",
      "/api/storage-groups",
      "/api/pipelines",
    ])
      expect(
        (await f.request(path, "GET", undefined, token.token)).status,
      ).toBe(403);
  } finally {
    await f.close();
  }
});

test("redundancy uses temporary results, publishes tasks atomically, runs post-save actions and deletes all copies", async () => {
  const f = await fixture();
  const calls: Array<{ body: any; key: string | null }> = [];
  const receiver = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({
        body: await req.json(),
        key: req.headers.get("idempotency-key"),
      });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const p = await profile(f),
      second = await local(f),
      g = await f.app.configuration.group(p.storageGroupId);
    await f.app.configuration.saveGroup(
      {
        ...g,
        members: [...g.members, { instanceId: second.id, weight: 3 }],
        redundancyCount: 1,
        expectedVersion: g.configVersion,
      },
      g.id,
    );
    const action = await f.app.plugins.save({
      pluginId: "test.action",
      stage: "post_save",
      version: "1.0.0",
      name: "Notify",
      config: { url: receiver.url.href },
    });
    await f.app.configuration.saveProfile(
      {
        ...p,
        postSavePipelineId: await actionPipeline(f, [action.id]),
        expectedVersion: p.configVersion,
      },
      p.id,
    );
    const result = await upload(f),
      record = (await f.app.db.read((r) => r.file(result.id)))!;
    expect(record.status).toBe("ready");
    expect(record.temp_status).toBe("available");
    expect(
      (await f.app.db.read((r) => r.tasks(result.id)))
        .map((t) => t.kind)
        .sort(),
    ).toEqual(["action", "write"]);
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.replicas(result.id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
    expect((await f.app.db.read((r) => r.file(result.id)))?.temp_status).toBe(
      "cleaned",
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.url).toBe(result.url);
    expect(calls[0]!.key).toStartWith(
      (await f.app.db.read((r) => r.tasks(result.id))).find(
        (t) => t.kind === "action",
      )!.id + ":",
    );
    const updated = await profile(f);
    await f.app.configuration.saveProfile(
      {
        ...updated,
        publicPrefix: "/new/",
        expectedVersion: updated.configVersion,
      },
      p.id,
    );
    const response = await f.request(new URL(result.url).pathname);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await f.request("/api/files/" + result.id, "DELETE");
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(result.id)))?.status).toBe(
      "deleted",
    );
    expect(
      (await f.app.db.read((r) => r.replicas(result.id))).every(
        (r) => r.status === "deleted",
      ),
    ).toBe(true);
    await f.app.configuration.deleteProfile(p.id);
    await f.app.configuration.deleteGroup(g.id);
    await f.app.plugins.remove(second.id);
    expect(await f.app.db.read((r) => r.instance(action.id))).not.toBeNull();
    const chain = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "post_save",
    )!;
    await f.app.configuration.deletePipeline(chain.id);
    expect(await f.app.db.read((r) => r.instance(action.id))).toBeNull();
  } finally {
    await receiver.stop(true);
    await f.close();
  }
});

test("post-save retry restarts the whole pipeline with stable operation IDs", async () => {
  const f = await fixture();
  let secondStatus = 503;
  const operations: string[] = [];
  const calls: string[] = [];
  const receiver = Bun.serve({
    port: 0,
    fetch: (req) => {
      calls.push(new URL(req.url).pathname);
      operations.push(req.headers.get("idempotency-key")!);
      return new Response(null, {
        status: new URL(req.url).pathname === "/second" ? secondStatus : 204,
      });
    },
  });
  try {
    const actions = [];
    for (const path of ["/first", "/second"])
      actions.push(
        await f.app.plugins.save({
          pluginId: "test.action",
          stage: "post_save",
          version: "1.0.0",
          name: path,
          config: { url: receiver.url.origin + path },
        }),
      );
    const p = await profile(f);
    await f.app.configuration.saveProfile(
      {
        ...p,
        postSavePipelineId: await actionPipeline(
          f,
          actions.map((a) => a.id),
        ),
        expectedVersion: p.configVersion,
      },
      p.id,
    );
    const result = await upload(f);
    await f.app.files.sweep();
    await f.app.files.sweep();
    const tasks = await f.app.db.read((r) => r.tasks(result.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("pending");
    expect(calls).toEqual(["/first", "/second"]);
    secondStatus = 204;
    // Simulate a crash during a later attempt: recovery must restart at step one.
    await f.app.db.transaction(async (r) => {
      const task = (await r.task(tasks[0]!.id))!;
      task.status = "running";
      await r.saveTask(task);
    });
    await f.restart();
    await f.app.files.sweep();
    expect(calls).toEqual(["/first", "/second", "/first", "/second"]);
    expect(operations.slice(2)).toEqual(operations.slice(0, 2));
    expect(operations[0]).not.toBe(operations[1]);
    expect((await f.app.db.read((r) => r.task(tasks[0]!.id)))?.status).toBe(
      "success",
    );
    expect(
      (await f.request("/api/tasks/" + tasks[0]!.id + "/skip", "POST")).status,
    ).toBe(404);
    expect((await f.app.db.read((r) => r.file(result.id)))?.temp_status).toBe(
      "cleaned",
    );
  } finally {
    await receiver.stop(true);
    await f.close();
  }
});

test("unknown redundant writes recover with task ID without writing twice", async () => {
  const f = await fixture();
  let operation = "",
    writes = 0;
  try {
    f.app.plugins.register({
      id: "test.unknown",
      name: "unknown",
      kind: "storage",
      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      configSchema: { type: "object", properties: {} },
      async createInstance() {
        return {
          async write(input) {
            writes++;
            operation = input.operationId;
            await new Response(await input.file.openRead()).arrayBuffer();
            throw new PluginError("NETWORK", "response lost", true);
          },
          async read() {
            throw Error();
          },
          async delete() {},
          async recoverWrite(input) {
            expect(input.operationId).toBe(operation);
            return { status: "stored", locator: { key: "exists" } };
          },
        };
      },
    });
    const storage = await f.app.plugins.save({
        pluginId: "test.unknown",
        version: "1",
        name: "Unknown",
        config: {},
      }),
      p = await profile(f),
      g = await f.app.configuration.group(p.storageGroupId);
    await f.app.configuration.saveGroup(
      {
        ...g,
        members: [...g.members, { instanceId: storage.id, weight: 1 }],
        redundancyCount: 1,
        expectedVersion: g.configVersion,
      },
      g.id,
    );
    const result = await upload(f);
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(result.id)))[0]!;
    expect(task.id).toBe(operation);
    expect(task.status).toBe("pending");
    expect((await f.app.db.read((r) => r.file(result.id)))?.temp_status).toBe(
      "available",
    );
    await f.app.db.transaction((r) =>
      r.saveTask({ ...task, next_run_at: Date.now() }),
    );
    await f.app.files.sweep();
    expect(writes).toBe(1);
    expect((await f.app.db.read((r) => r.task(task.id)))?.status).toBe(
      "success",
    );
  } finally {
    await f.close();
  }
});

test("weighted selection is deterministic and redundancy excludes chosen targets", () => {
  const items = [
    { id: "a", priority: 1, weight: 1 },
    { id: "b", priority: 0, weight: 3 },
  ];
  expect(selectStorage(items, "priority", () => 0).id).toBe("b");
  expect(selectStorage(items, "weighted_random", () => 0).id).toBe("a");
  expect(selectStorage(items, "weighted_random", () => 0.5).id).toBe("b");
  expect(() =>
    selectStorage([{ priority: 0, weight: 0 }], "weighted_random"),
  ).toThrow();
});

test("restart restores pending redundant work and profile deletion waits for existing uploads", async () => {
  const f = await fixture();
  try {
    const p = await profile(f),
      g = await f.app.configuration.group(p.storageGroupId),
      second = await local(f);
    await f.app.configuration.saveGroup(
      {
        ...g,
        members: [...g.members, { instanceId: second.id, weight: 3 }],
        redundancyCount: 1,
        expectedVersion: g.configVersion,
      },
      g.id,
    );
    const result = await upload(f),
      pending = (await f.app.db.read((r) => r.tasks(result.id)))[0]!;
    await f.app.db.transaction(async (r) => {
      const replica = (await r.replica(pending.replica_id!))!;
      replica.status = "writing";
      await r.saveReplica(replica);
      await r.saveTask({ ...pending, status: "running" });
    });
    await f.restart();
    expect((await f.app.db.read((r) => r.task(pending.id)))?.status).toBe(
      "success",
    );
    expect((await f.app.db.read((r) => r.file(result.id)))?.temp_status).toBe(
      "cleaned",
    );
  } finally {
    await f.close();
  }
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (resume = r));
  const slow = await fixture({
    beforeWrite: async () => {
      enter();
      await gate;
    },
  });
  try {
    const uploading = upload(slow);
    await entered;
    let deleted = false;
    const deleting = slow.app.configuration
      .deleteProfile(slow.profileId)
      .then(() => (deleted = true));
    await Bun.sleep(10);
    expect(deleted).toBe(false);
    expect((await slow.upload()).status).toBe(409);
    resume();
    const result = await uploading;
    await deleting;
    const file = await slow.app.db.read((r) => r.file(result.id));
    expect(file?.upload_profile_id).toBeNull();
    expect(file?.status).toBe("ready");
  } finally {
    resume();
    await slow.close();
  }
});

test("deleting during an action stops the chain and cleans temporary data after the call ends", async () => {
  const f = await fixture();
  let entered!: () => void;
  const running = new Promise<void>((r) => (entered = r));
  try {
    f.app.plugins.register({
      id: "test.cancel-action",
      name: "cancel",
      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              async execute(_, ctx) {
                entered();
                await new Promise<void>((_, reject) => {
                  if (ctx.signal.aborted) reject(ctx.signal.reason);
                  else
                    ctx.signal.addEventListener(
                      "abort",
                      () => reject(ctx.signal.reason),
                      { once: true },
                    );
                });
                return { status: "pass" };
              },
            };
          },
        },
      },
    });
    const instance = await f.app.plugins.save({
        pluginId: "test.cancel-action",
        stage: "post_save",
        version: "1",
        name: "cancel",
        config: {},
      }),
      p = await profile(f);
    await f.app.configuration.saveProfile(
      {
        ...p,
        postSavePipelineId: await actionPipeline(f, [instance.id]),
        expectedVersion: p.configVersion,
      },
      p.id,
    );
    const result = await upload(f),
      sweep = f.app.files.sweep();
    await running;
    await f.app.files.delete(result.id);
    await sweep;
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(result.id)))?.status).toBe(
      "deleted",
    );
    expect(
      (await f.app.db.read((r) => r.tasks(result.id))).find(
        (t) => t.kind === "action",
      )?.status,
    ).toBe("cancelled");
  } finally {
    await f.close();
  }
});

test("storage usage returns a replica count without enumerating file references", async () => {
  const f = await fixture();
  try {
    await upload(f);
    await upload(f);
    const p = await profile(f);
    const group = await f.app.configuration.group(p.storageGroupId);
    const sourceId = group.members[0]!.instanceId;
    const view = await payload(
      await f.request("/api/storage-sources/" + sourceId),
    );
    expect(view.replicaCount).toBe(2);
    expect(
      view.references.some(
        (reference: { type: string }) => reference.type === "replica",
      ),
    ).toBe(false);
    expect(
      view.references.some(
        (reference: { type: string }) => reference.type === "group",
      ),
    ).toBe(true);
    await f.app.db.transaction(async (r) => {
      await r.deleteProfile(p.id);
      await r.deleteGroup(group.id);
    });
    expect(
      (await f.request("/api/storage-sources/" + sourceId, "DELETE")).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test("background tasks refill a free slot after failure while another task remains blocked", async () => {
  const f = await fixture();
  let release!: () => void;
  let startedThird!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const third = new Promise<void>((resolve) => {
    startedThird = resolve;
  });
  let sweep: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let active = 0,
    peak = 0;
  const started: string[] = [];
  const ids: string[] = [];
  try {
    f.app.config.taskConcurrency = 2;
    f.app.plugins.register({
      id: "test.refill",
      name: "Refill",
      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              async execute(input) {
                started.push(input.fileId);
                peak = Math.max(peak, ++active);
                try {
                  if (input.fileId === ids[1])
                    throw new PluginError(
                      "FAILED",
                      "Expected failure",
                      false,
                    );
                  if (input.fileId === ids[2]) startedThird();
                  await gate;
                  return { status: "pass" as const };
                } finally {
                  active--;
                }
              },
            };
          },
        },
      },
    });
    const pipeline = await f.app.configuration.savePipeline({
      name: "Refill",
      kind: "post_save",
      steps: [{ pluginId: "test.refill", version: "1", config: {} }],
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
    for (let i = 0; i < 3; i++) {
      const image = await (await f.upload()).json();
      ids.push(image.id);
      // Establish an explicit due order without depending on clock resolution.
      await f.app.db.transaction(async (r) => {
        const task = (await r.tasks(image.id))[0]!;
        task.next_run_at = i;
        await r.saveTask(task);
      });
    }
    sweep = f.app.files.sweep();
    await Promise.race([
      third,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Free task slot was not refilled")),
          1500,
        );
      }),
    ]);
    expect(started).toEqual(ids);
    expect(active).toBe(2);
    expect(peak).toBe(2);
    expect((await f.app.db.read((r) => r.tasks(ids[0]!)))[0]!.status).toBe(
      "running",
    );
    expect((await f.app.db.read((r) => r.tasks(ids[1]!)))[0]!.status).toBe(
      "failed",
    );
    release();
    await sweep;
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    clearTimeout(deadline);
    release();
    await sweep;
    await f.close();
  }
});

test("relative local directories resolve under data and preserve immutable targets", async () => {
  const f = await fixture();
  try {
    const source = await payload(
      await f.request("/api/storage-sources", "POST", {
        pluginId: "builtin.local",
        version: "1.0.0",
        name: "Relative",
        config: { root: "./images" },
        secretEdits: {},
      }),
    );
    expect(source.config.root).toBe(join(f.root, "images"));
    expect(source.ready).toBe(true);
    const record = await f.app.db.read((r) => r.instance(source.id));
    expect(f.app.plugins.localDirectory(record!)!.root).toBe(
      join(f.root, "images"),
    );
    const same = await f.request(`/api/storage-sources/${source.id}`, "PUT", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Relative",
      config: { root: "./images" },
      secretEdits: {},
      expectedVersion: source.configVersion,
    });
    expect(same.status).toBe(200);
    const saved = await same.json();
    const moved = await f.request(`/api/storage-sources/${source.id}`, "PUT", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Relative",
      config: { root: "./other-images" },
      secretEdits: {},
      expectedVersion: saved.configVersion,
    });
    expect((await moved.json()).error.code).toBe("NEW_INSTANCE_REQUIRED");
  } finally {
    await f.close();
  }
});
