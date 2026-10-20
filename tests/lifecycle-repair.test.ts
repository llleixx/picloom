import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { PluginError } from "../plugin-sdk";

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
      redundancyCount: 1,
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
      if (failing)
        throw new PluginError("NETWORK", "offline", true, "notApplied");
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
    const [task] = await f.app.db.read((r) => r.tasks(image.id));
    expect(task).toMatchObject({ status: "failed", attempts: 2 });
    await f.app.files.sweep();
    await f.restart();
    await f.app.files.sweep();
    expect(calls).toBe(2);
    expect(await f.app.db.read((r) => r.tasks(image.id))).toHaveLength(1);
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
    write.mockRejectedValue(
      new PluginError("NETWORK", "offline", false, "notApplied"),
    );
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const [task] = await f.app.db.read((r) => r.tasks(image.id));
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

test("unknown write is verified without rewriting; missing repair source is reported before scheduling", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const write = spyOn(lease.runtime, "write");
  const recover = spyOn(lease.runtime, "recoverWrite");
  try {
    write.mockRejectedValue(
      new PluginError("NETWORK", "uncertain", false, "unknown"),
    );
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const [task] = await f.app.db.read((r) => r.tasks(image.id));
    await f.app.db.transaction(async (r) => {
      const other = (await r.replicas(image.id)).find(
        (x) => x.storage_instance_id !== source.id,
      )!;
      await r.saveReplica({ ...other, status: "write_failed" });
    });
    recover.mockResolvedValue({ status: "stored", locator: null });
    await f.app.files.tasks.retry(task!.id);
    await f.app.files.sweep();
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      await f.app.db.read((r) => r.replica(task!.replica_id!)),
    ).toMatchObject({ status: "ready" });
    await f.app.db.transaction(async (r) => {
      const replica = (await r.replica(task!.replica_id!))!;
      const current = (await r.task(task!.id))!;
      await r.saveReplica({ ...replica, status: "write_failed" });
      await r.saveTask({ ...current, status: "failed" });
    });
    const response = await f.request(`/api/tasks/${task!.id}/retry`, "POST");
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("REPAIR_SOURCE_MISSING");
    const operations = await (
      await f.request(`/api/files/${image.id}/operations`)
    ).json();
    expect(operations.tasks[0].retryError).toBe("REPAIR_SOURCE_MISSING");
  } finally {
    write.mockRestore();
    recover.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("unknown cleanup uses bounded tasks, does not block healthy deletion, and can be ignored", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const write = spyOn(lease.runtime, "write").mockRejectedValue(
    new PluginError("NETWORK", "unknown", false, "unknown"),
  );
  const recover = spyOn(lease.runtime, "recoverWrite").mockResolvedValue({
    status: "unknown",
  });
  try {
    f.app.config.retryLimit = 1;
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "delete_failed",
    );
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    expect(replica.status).toBe("write_unknown");
    expect(recover).toHaveBeenCalledTimes(1);
    await f.app.files.sweep();
    expect(recover).toHaveBeenCalledTimes(1);
    await f.app.files.ignoreReplica(image.id, replica.id);
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleted",
    );
    expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(0);
  } finally {
    write.mockRestore();
    recover.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("restart converts interrupted writes to unknown without resetting an exhausted retry budget", async () => {
  const { f } = await redundant();
  try {
    const image = await (await f.upload()).json();
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
    ).toMatchObject({ status: "write_unknown" });
    expect(
      (await f.app.db.read((r) => r.file(image.id)))?.temp_path,
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test("a failed verification never turns an earlier unknown write into an absent object", async () => {
  const { f, source } = await redundant();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const originalWrite = lease.runtime.write.bind(lease.runtime);
  const write = spyOn(lease.runtime, "write").mockImplementation(
    async (input, context) => {
      await originalWrite(input, context);
      throw new PluginError(
        "NETWORK",
        "Response lost after commit",
        false,
        "unknown",
      );
    },
  );
  const recover = spyOn(lease.runtime, "recoverWrite").mockRejectedValue(
    new PluginError(
      "ACCESS_DENIED",
      "Verification denied",
      false,
      "notApplied",
    ),
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "write",
    )!;
    const file = (await f.app.db.read((r) => r.file(image.id)))!;
    expect(
      await Bun.file(join(f.root, "repair-target", file.storage_key)).exists(),
    ).toBe(true);
    await f.app.files.tasks.retry(task.id);
    await f.app.files.sweep();
    expect(
      await f.app.db.read((r) => r.replica(task.replica_id!)),
    ).toMatchObject({ status: "write_unknown" });
    expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(
      f.png.length,
    );
    expect(write).toHaveBeenCalledTimes(1);
    recover.mockRestore();
    await f.app.files.tasks.retry(task.id);
    await f.app.files.sweep();
    expect(
      await f.app.db.read((r) => r.replica(task.replica_id!)),
    ).toMatchObject({ status: "ready" });
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    write.mockRestore();
    recover.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("restart makes exhausted tasks recoverable even before their replica operation starts", async () => {
  const { f } = await redundant();
  try {
    const image = await (await f.upload()).json();
    const [write] = await f.app.db.read((r) => r.tasks(image.id));
    await f.app.db.transaction(async (r) => {
      await r.saveTask({
        ...write!,
        status: "running",
        attempts: f.app.config.retryLimit,
      });
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
