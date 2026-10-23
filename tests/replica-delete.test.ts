import { SqlRepositories } from "../src/persistence/repositories";
import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { PluginError } from "../src/plugins/api";
async function setup() {
  const f = await fixture();
  const source = await (
    await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Second",
      config: { root: join(f.root, "second") },
      secretEdits: {},
    })
  ).json();
  const profile = await f.app.configuration.profile(f.profileId);
  const original = await f.app.configuration.group(profile.storageGroupId);
  const group = await f.app.configuration.saveGroup(
    {
      ...original,
      members: [...original.members, { instanceId: source.id, weight: 1 }],
      replicaCount: 2,
      expectedVersion: original.configVersion,
    },
    original.id,
  );
  return { f, source, group, original };
}
test("source filtering survives group changes; deleting a replica preserves URL and releases source references", async () => {
  const { f, source, group, original } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await f.app.configuration.saveGroup(
      {
        ...group,
        members: original.members,
        replicaCount: 1,
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    const filtered = await f.request(
      `/api/files?source=${source.id}&status=ready&limit=1`,
    );
    expect(filtered.headers.get("X-Total-Count")).toBe("1");
    expect((await filtered.json())[0].id).toBe(image.id);
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    expect(
      (
        await f.request(
          `/api/files/${image.id}/replicas/${replica.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await f.restart();
    expect((await f.app.db.read((r) => r.replica(replica.id)))!.status).toBe(
      "deleted",
    );
    const response = await f.request(new URL(image.url).pathname);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
    expect(
      await Bun.file(
        join(
          f.root,
          "second",
          (await f.app.db.read((r) => r.file(image.id)))!.storage_key,
        ),
      ).exists(),
    ).toBe(false);
    expect(
      (await f.request(`/api/files?source=${source.id}`)).headers.get(
        "X-Total-Count",
      ),
    ).toBe("0");
    expect(
      (await f.request(`/api/storage-sources/${source.id}`, "DELETE")).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});
test("concurrent replica deletions preserve one ready copy; source batch requires explicit whole-file opt-in", async () => {
  const { f } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replicas = await f.app.db.read((r) => r.replicas(image.id));
    const responses = await Promise.all(
      replicas.map((r) =>
        f.request(`/api/files/${image.id}/replicas/${r.id}`, "DELETE"),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const remaining = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.status === "ready",
    )!;
    const input = { ids: [image.id], sourceId: remaining.storage_instance_id };
    const result = await (
      await f.request("/api/files/batch-delete", "POST", input)
    ).json();
    expect(result.results[0].error).toBe("LAST_REPLICA");
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "ready",
    );
    expect(
      (
        await (
          await f.request("/api/files/batch-delete", "POST", {
            ...input,
            includeLast: true,
          })
        ).json()
      ).results[0].accepted,
    ).toBe(true);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "deleted",
    );
    expect((await f.request(new URL(image.url).pathname)).status).toBe(404);
  } finally {
    await f.close();
  }
});
test("replica deletion failure can retry while file stays ready; upload tokens cannot filter or delete replicas", async () => {
  const { f, source } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    const token = await (
      await f.request("/api/tokens", "POST", { name: "test" })
    ).json();
    expect(
      (
        await f.request(
          `/api/files?source=${source.id}`,
          "GET",
          undefined,
          token.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `/api/files/${image.id}/replicas/${replica.id}`,
          "DELETE",
          undefined,
          token.token,
        )
      ).status,
    ).toBe(403);
    const lease = f.app.plugins.acquire(source.id, "storage");
    const originalDelete = lease.runtime.delete;
    lease.runtime.delete = async () => {
      throw new PluginError("FAILED", "fail", false, "notApplied");
    };
    await f.app.files.deleteReplica(image.id, replica.id);
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(task.status).toBe("failed");
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "ready",
    );
    lease.runtime.delete = originalDelete;
    await lease.release();
    expect(
      (await f.request(`/api/tasks/${task.id}/retry`, "POST")).status,
    ).toBe(200);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.replica(replica.id)))!.status).toBe(
      "deleted",
    );
  } finally {
    await f.close();
  }
});

test("exhausted uncertain replica writes release local source without losing remote state", async () => {
  const { f, source } = await setup();
  const lease = f.app.plugins.acquire(source.id, "storage");
  const write = spyOn(lease.runtime, "write").mockRejectedValue(
    new PluginError("FAILED", "Uncertain write", false, "unknown"),
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.replica_id === replica.id,
    )!;
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "failed",
    );
    expect((await f.app.db.read((r) => r.replica(replica.id)))!.status).toBe(
      "write_unknown",
    );
    expect(
      (await f.app.db.read((r) => r.file(image.id)))!.temp_path,
    ).toBeNull();
    expect(f.app.files.temporary.bytes).toBe(0);
    const response = await f.request(new URL(image.url).pathname);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  } finally {
    write.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("source-filtered file lists batch pending deletions for the current page", async () => {
  const { f, source } = await setup();
  let tasks: ReturnType<typeof spyOn> | undefined;
  let pending: ReturnType<typeof spyOn> | undefined;
  try {
    const first = await (await f.upload()).json();
    const second = await (await f.upload()).json();
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(first.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    await f.app.files.deleteReplica(first.id, replica.id);
    tasks = spyOn(SqlRepositories.prototype, "tasks");
    pending = spyOn(SqlRepositories.prototype, "pendingFileDeletions");
    const response = await f.request("/api/files?source=" + source.id);
    expect(response.status).toBe(200);
    const items = await response.json();
    expect(
      items.find((item: { id: string }) => item.id === first.id)
        .backgroundPending,
    ).toBe(true);
    expect(
      items.find((item: { id: string }) => item.id === second.id)
        .backgroundPending,
    ).toBe(false);
    expect(tasks).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledTimes(1);
    expect(new Set(pending.mock.calls[0]![0])).toEqual(
      new Set([first.id, second.id]),
    );
  } finally {
    tasks?.mockRestore();
    pending?.mockRestore();
    await f.close();
  }
});

test("one failed replica recovery does not block deletion of healthy replicas", async () => {
  const { f, source } = await setup();
  let recovery: ReturnType<typeof spyOn> | undefined;
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replicas = await f.app.db.read((r) => r.replicas(image.id));
    const uncertain = replicas.find(
      (r) => r.storage_instance_id === source.id,
    )!;
    const healthy = replicas.find((r) => r.id !== uncertain.id)!;
    await f.app.db.transaction((r) =>
      r.saveReplica({ ...uncertain, status: "write_unknown" }),
    );
    const lease = f.app.plugins.acquire(source.id, "storage");
    recovery = spyOn(lease.runtime, "recoverWrite").mockRejectedValue(
      new Error("Unreachable storage"),
    );
    await lease.release();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    expect(recovery).toHaveBeenCalled();
    expect((await f.app.db.read((r) => r.replica(healthy.id)))?.status).toBe(
      "deleted",
    );
    expect((await f.app.db.read((r) => r.replica(uncertain.id)))?.status).toBe(
      "write_unknown",
    );
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleting",
    );
    recovery.mockRestore();
    recovery = undefined;
    await f.app.db.transaction(async (r) => {
      const task = (await r.tasks(image.id)).find(
        (t) => t.replica_id === uncertain.id && t.kind === "delete",
      )!;
      await r.saveTask({ ...task, next_run_at: Date.now() });
    });
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))?.status).toBe(
      "deleted",
    );
  } finally {
    recovery?.mockRestore();
    await f.close();
  }
});

test("ignoring an abnormal replica removes only its local records and releases capacity", async () => {
  const { f, source } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replicas = await f.app.db.read((r) => r.replicas(image.id));
    const replica = replicas.find((r) => r.storage_instance_id === source.id)!;
    const other = replicas.find((r) => r.id !== replica.id)!;
    const lease = f.app.plugins.acquire(source.id, "storage");
    const remove = spyOn(lease.runtime, "delete");
    try {
      const endpoint = `/api/files/${image.id}/replicas/${replica.id}/ignore`;
      expect(
        (await f.request(endpoint, "POST", { confirm: true })).status,
      ).toBe(409);
      await f.app.db.transaction((r) =>
        r.saveReplica({ ...replica, status: "write_unknown" }),
      );
      expect((await f.request(endpoint, "POST", {})).status).toBe(400);
      const token = await (
        await f.request("/api/tokens", "POST", { name: "test" })
      ).json();
      expect(
        (await f.request(endpoint, "POST", { confirm: true }, token.token))
          .status,
      ).toBe(403);
      expect(
        (
          await f.request(
            `/api/files/wrong/replicas/${replica.id}/ignore`,
            "POST",
            { confirm: true },
          )
        ).status,
      ).toBe(404);
      const tasks = await f.app.db.read((r) => r.tasks(image.id));
      const task = tasks.find((t) => t.replica_id === replica.id)!;
      await f.app.db.transaction((r) =>
        r.saveTask({ ...task, status: "running" }),
      );
      expect(
        (await f.request(endpoint, "POST", { confirm: true })).status,
      ).toBe(409);
      await f.app.db.transaction((r) =>
        r.saveTask({ ...task, status: "pending", next_run_at: Date.now() }),
      );
      expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(
        f.png.length,
      );
      expect(
        (await f.request(endpoint, "POST", { confirm: true })).status,
      ).toBe(200);
      expect(await f.app.db.read((r) => r.replica(replica.id))).toBeNull();
      expect(await f.app.db.read((r) => r.task(task.id))).toBeNull();
      expect(await f.app.db.read((r) => r.replica(other.id))).toEqual(other);
      expect(await f.app.db.read((r) => r.storageUsedBytes(source.id))).toBe(0);
      expect(
        (
          await f.request(`/api/files?status=replica_error&source=${source.id}`)
        ).headers.get("X-Total-Count"),
      ).toBe("0");
      await f.app.files.sweep();
      expect(remove).not.toHaveBeenCalled();
      const readable = await f.request(new URL(image.url).pathname);
      expect(readable.status).toBe(200);
      expect((await readable.arrayBuffer()).byteLength).toBe(f.png.length);
    } finally {
      remove.mockRestore();
      await lease.release();
    }
  } finally {
    await f.close();
  }
});
