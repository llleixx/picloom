import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { PluginError } from "@picloom/plugin-sdk";

async function redundant() {
  const f = await fixture();
  const source = await (
    await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Repair target",
      config: { root: join(f.root, "repair-target") },
    })
  ).json();
  const profile = await f.app.configuration.profile(f.profileId);
  const group = await f.app.configuration.group(profile.storageGroupId);
  await f.app.configuration.saveGroup(
    {
      ...group,
      selectionStrategy: "priority",
      members: [...group.members, { instanceId: source.id, weight: 1 }],
      replicaCount: 2,
      expectedVersion: group.configVersion,
    },
    group.id,
  );
  return { f, source };
}

async function due(f: Awaited<ReturnType<typeof fixture>>) {
  await f.app.db.transaction(async (r) => {
    for (const file of await r.files(100, 0))
      for (const task of await r.tasks(file.id))
        if (task.status === "pending")
          await r.saveTask({ ...task, next_run_at: Date.now() });
  });
}

test("deletion exhausts one budget, survives restart, and resumes only on explicit retry", async () => {
  let failing = true,
    calls = 0;
  const f = await fixture({
    beforeDelete: async () => {
      calls++;
      if (failing) throw new PluginError("NETWORK", "offline", true);
    },
  });
  try {
    f.app.config.retryLimit = 2;
    const image = await (await f.upload()).json();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleting",
    );
    await due(f);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "delete_failed",
    );
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.status === "failed",
    );
    expect(task).toMatchObject({ status: "failed", attempts: 2 });
    await f.app.files.sweep();
    await f.restart();
    await f.app.files.sweep();
    expect(calls).toBe(2);
    expect(
      (await f.app.db.read((r) => r.tasks(image.id))).filter(
        (t) => t.kind === "delete",
      ),
    ).toHaveLength(1);
    failing = false;
    expect(
      (await f.request(`/api/tasks/${task!.id}/retry`, "POST")).status,
    ).toBe(200);
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleting",
    );
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleted",
    );
    expect(calls).toBe(3);
  } finally {
    await f.close();
  }
});

test("repair reads another replica after temp cleanup, respects capacity, and releases repair temp", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const write = spyOn(lease.runtime, "write");
  try {
    write.mockRejectedValue(new PluginError("NETWORK", "offline", false));
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.status === "failed",
    );
    const file = (await f.app.db.read((r) => r.file(image.id)))!;
    expect(file.temp_path).toBeNull();
    expect(f.app.files.temporary.bytes).toBe(0);
    write.mockRestore();
    await f.app.db.transaction(async (r) => {
      const instance = (await r.instance(source.id))!;
      await r.saveInstance(
        { ...instance, max_storage_bytes: 1 },
        instance.config_version,
      );
    });
    await f.app.files.tasks.retry(task!.id);
    await f.app.files.sweep();
    expect(await f.app.db.read((r) => r.task(task!.id))).toMatchObject({
      status: "failed",
      last_error: "STORAGE_CAPACITY_EXCEEDED",
    });
    expect(f.app.files.temporary.bytes).toBe(0);
    await f.app.db.transaction(async (r) => {
      const instance = (await r.instance(source.id))!;
      await r.saveInstance(
        { ...instance, max_storage_bytes: f.png.length },
        instance.config_version,
      );
    });
    await f.app.files.tasks.retry(task!.id);
    await f.app.files.sweep();
    expect(await f.app.db.read((r) => r.task(task!.id))).toMatchObject({
      status: "success",
    });
    expect(
      (await f.app.db.read((r) => r.replicas(image.id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
    expect(
      await Bun.file(join(f.root, "repair-target", file.storage_key)).bytes(),
    ).toEqual(new Uint8Array(f.png));
    expect(f.app.files.temporary.bytes).toBe(0);
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "ready",
    );
  } finally {
    write.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("failed write retries directly with its task ID and rejects a missing source", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const original = lease.runtime.write.bind(lease.runtime);
  const write = spyOn(lease.runtime, "write").mockRejectedValue(
    new PluginError("NETWORK", "Response lost", false),
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.status === "failed",
    )!;
    write.mockImplementation(async (input, context) => {
      expect(input.operationId).toBe(task.id);
      return original(input, context);
    });
    await f.app.files.tasks.retry(task.id);
    await f.app.files.sweep();
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      await f.app.db.read((r) => r.replica(task.replica_id!)),
    ).toMatchObject({ status: "ready" });
    await f.app.db.transaction(async (r) => {
      for (const replica of await r.replicas(image.id))
        await r.saveReplica({ ...replica, status: "write_failed" });
      const current = (await r.task(task.id))!;
      await r.saveTask({ ...current, status: "failed" });
    });
    expect(
      (await f.request(`/api/tasks/${task.id}/retry`, "POST")).status,
    ).toBe(409);
    const operations = await (
      await f.request(`/api/files/${image.id}/operations`)
    ).json();
    expect(
      operations.tasks.find((t: { id: string }) => t.id === task.id).retryError,
    ).toBe("REPAIR_SOURCE_MISSING");
  } finally {
    write.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("failed-write cleanup has a bounded delete budget and termination keeps failed history", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const write = spyOn(lease.runtime, "write").mockRejectedValue(
    new PluginError("NETWORK", "Response lost", false),
  );
  const remove = spyOn(lease.runtime, "delete").mockRejectedValue(
    new PluginError("ACCESS_DENIED", "Denied", false),
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    expect(replica.status).toBe("delete_failed");
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "delete_failed",
    );
    expect(remove).toHaveBeenCalledTimes(1);
    const tasks = await f.app.db.read((r) => r.tasks(image.id));
    const failedDelete = tasks.find(
      (t) => t.replica_id === replica.id && t.kind === "delete",
    )!;
    await f.app.files.sweep();
    expect(remove).toHaveBeenCalledTimes(1);
    const unrelated = await (await f.upload()).json();
    await f.app.files.delete(unrelated.id);
    await f.app.files.terminateReplica(image.id, replica.id);
    expect(
      (await f.app.db.read((r) => r.tasks(unrelated.id))).some(
        (t) => t.kind === "delete",
      ),
    ).toBe(false);
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleted",
    );
    expect(await f.app.db.read((r) => r.task(failedDelete.id))).toEqual(
      failedDelete,
    );
    await expect(
      f.app.files.tasks.retry(failedDelete.id),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(
      f.png.length,
    );
  } finally {
    write.mockRestore();
    remove.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("restart converts interrupted writes to failure without resetting an exhausted retry budget", async () => {
  const { f } = await redundant();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.tasks.drain();
    const [task] = await f.app.db.read((r) => r.tasks(image.id));
    await f.app.db.transaction(async (r) => {
      await r.saveTask({
        ...task!,
        status: "running",
        attempts: f.app.config.retryLimit,
      });
      const replica = (await r.replica(task!.replica_id!))!;
      await r.saveReplica({ ...replica, status: "writing" });
    });
    await f.restart();
    expect(await f.app.db.read((r) => r.task(task!.id))).toMatchObject({
      status: "failed",
      attempts: f.app.config.retryLimit,
    });
    expect(
      await f.app.db.read((r) => r.replica(task!.replica_id!)),
    ).toMatchObject({ status: "write_failed" });
    expect(
      (await f.app.db.read((r) => r.file(image.id)))?.temp_path,
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test("a lost write response is retried directly and remains counted once", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const original = lease.runtime.write.bind(lease.runtime);
  let fail = true;
  const write = spyOn(lease.runtime, "write").mockImplementation(
    async (input, context) => {
      const result = await original(input, context);
      if (fail)
        throw new PluginError("NETWORK", "Response lost after commit", false);
      return result;
    },
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "write" && t.status === "failed",
    )!;
    expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(
      f.png.length,
    );
    fail = false;
    await f.app.files.tasks.retry(task.id);
    await f.app.files.sweep();
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      await f.app.db.read((r) => r.replica(task.replica_id!)),
    ).toMatchObject({ status: "ready" });
    expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(
      f.png.length,
    );
  } finally {
    write.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("restart makes exhausted tasks recoverable even before their replica operation starts", async () => {
  const { f } = await redundant();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.tasks.drain();
    const [write] = await f.app.db.read((r) => r.tasks(image.id));
    await f.app.db.transaction(async (r) => {
      await r.saveTask({
        ...write!,
        status: "running",
        attempts: f.app.config.retryLimit,
      });
      const replica = (await r.replica(write!.replica_id!))!;
      await r.saveReplica({ ...replica, status: "pending" });
    });
    await f.restart();
    expect(
      await f.app.db.read((r) => r.replica(write!.replica_id!)),
    ).toMatchObject({ status: "write_failed" });
    expect(
      (await f.request(`/api/tasks/${write!.id}/retry`, "POST")).status,
    ).toBe(200);
    await f.app.files.sweep();
    expect(
      await f.app.db.read((r) => r.replica(write!.replica_id!)),
    ).toMatchObject({ status: "ready" });

    await f.app.files.delete(image.id);
    await f.app.files.tasks.cleanupPending();
    const deletes = (await f.app.db.read((r) => r.tasks(image.id))).filter(
      (t) => t.kind === "delete",
    );
    await f.app.db.transaction(async (r) => {
      for (const task of deletes)
        await r.saveTask({ ...task, status: "running", manual_retry: true });
    });
    await f.restart();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "delete_failed",
    );
    for (const task of deletes) {
      expect(
        await f.app.db.read((r) => r.replica(task.replica_id!)),
      ).toMatchObject({ status: "delete_failed" });
      expect(
        (await f.request(`/api/tasks/${task.id}/retry`, "POST")).status,
      ).toBe(200);
    }
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleted",
    );
  } finally {
    await f.close();
  }
});

for (const existing of ["managed", "unregistered"] as const) {
  test(`failed-upload cleanup preserves ${existing} objects at a conflicting storage key`, async () => {
    const f = await fixture();
    const storageKey = "shared.png";
    try {
      f.app.plugins.register({
        id: "test.shared-storage-key",
        kind: "path",
        version: "1",
        apiVersion: 1,
        configSchemaVersion: 1,
        configSchema: { type: "object" },
        defaultLocale: "en-US",
        nameKey: "package.name",
        messages: { "en-US": { "package.name": "Shared storage key" } },
        async createInstance() {
          return {
            async generate({ fileId }) {
              return { logicalKey: `${fileId}.png`, storageKey };
            },
          };
        },
      });
      const path = await f.app.plugins.save({
        pluginId: "test.shared-storage-key",
        version: "1",
        name: "Shared storage key",
        config: {},
      });
      await f.app.db.transaction(async (r) => {
        const profile = (await r.profile(f.profileId))!;
        await r.saveProfile(
          {
            ...profile,
            path_instance_id: path.id,
            config_version: profile.config_version + 1,
          },
          profile.config_version,
        );
      });
      const object = Bun.file(join(f.root, "originals", storageKey));
      const bytes =
        existing === "managed"
          ? new Uint8Array(f.png)
          : new TextEncoder().encode("Preexisting object outside Picloom");
      let original: { id: string; url: string } | undefined;
      if (existing === "managed") {
        const uploaded = await f.upload();
        expect(uploaded.status).toBe(201);
        original = await uploaded.json();
      } else await Bun.write(object, bytes);

      expect((await f.upload()).status).toBe(502);
      await f.app.files.sweep();
      expect(await object.bytes()).toEqual(bytes);
      if (original) {
        expect(await f.app.db.read((r) => r.file(original!.id))).toMatchObject({
          status: "ready",
        });
        const readable = await f.request(new URL(original.url).pathname);
        expect(readable.status).toBe(200);
        expect(new Uint8Array(await readable.arrayBuffer())).toEqual(bytes);
      }
    } finally {
      await f.close();
    }
  });
}
