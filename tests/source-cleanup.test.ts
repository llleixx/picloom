import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { entity } from "../src/persistence/port";
import { PluginError } from "../src/plugins/api";
async function setup() {
  const f = await fixture();
  const source = await (
    await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Cleanup target",
      config: { root: join(f.root, "target") },
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
  const remove = () =>
    f.app.configuration.saveGroup(
      {
        ...group,
        members: original.members,
        replicaCount: 1,
        expectedVersion: group.configVersion,
      },
      group.id,
    );
  return { f, source, remove };
}
async function complete(f: Awaited<ReturnType<typeof fixture>>) {
  await f.app.cleanups.tick();
  await f.app.files.sweep();
  await f.app.cleanups.tick();
}

test("detach is confirmed and admin only, keeps storage files with unavailable plugins and releases references/history", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await remove();
    const replica = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    const path = join(
      f.root,
      "target",
      (await f.app.db.read((r) => r.file(image.id)))!.storage_key,
    );
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    for (const url of [
      `/api/files/${image.id}/detach`,
      `/api/files/${image.id}/replicas/${replica.id}/detach`,
      "/api/files/batch-detach",
    ]) {
      expect(
        (
          await f.request(
            url,
            "POST",
            { ids: [image.id], confirm: true },
            token.token,
          )
        ).status,
      ).toBe(403);
      expect((await f.request(url, "POST", { ids: [image.id] })).status).toBe(
        400,
      );
    }
    const acquire = spyOn(f.app.plugins, "acquire").mockImplementation(() => {
      throw new Error("unavailable");
    });
    try {
      expect(
        (
          await f.request(
            `/api/files/${image.id}/replicas/${replica.id}/detach`,
            "POST",
            { confirm: true },
          )
        ).status,
      ).toBe(200);
      expect(acquire).not.toHaveBeenCalled();
      expect(await Bun.file(path).exists()).toBe(true);
      expect(
        await f.app.db.read((r) => r.instanceReplicaCount(source.id)),
      ).toBe(0);
      expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
        "ready",
      );
      expect(
        (await f.app.db.read((r) => r.storageUsage([source.id]))).get(
          source.id,
        ) ?? 0,
      ).toBe(0);
      expect(
        (await f.app.db.read((r) => r.tasks(image.id))).length,
      ).toBeGreaterThan(0);
      const left = (await f.app.db.read((r) => r.replicas(image.id))).find(
        (r) => r.status === "ready",
      )!;
      expect(
        (
          await f.request(
            `/api/files/${image.id}/replicas/${left.id}/detach`,
            "POST",
            { confirm: true, includeLast: false },
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await f.request(`/api/files/${image.id}/detach`, "POST", {
            confirm: true,
          })
        ).status,
      ).toBe(200);
      expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
        "deleted",
      );
    } finally {
      acquire.mockRestore();
    }
    expect(
      (await f.request(`/api/storage-sources/${source.id}`, "DELETE")).status,
    ).toBe(200);
    expect(await f.app.db.read((r) => r.replica(replica.id))).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("replica default deletes whole last image including failed replicas; preserve-last rechecks current replicas", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await remove();
    const replicas = await f.app.db.read((r) => r.replicas(image.id));
    const target = replicas.find((r) => r.storage_instance_id === source.id)!;
    const other = replicas.find((r) => r.id !== target.id)!;
    await f.app.db.transaction(async (r) => {
      other.status = "write_failed";
      await r.saveReplica(other);
    });
    const kept = await f.app.cleanups.submit(source.id, "delete", false);
    await complete(f);
    expect((await f.app.cleanups.detail(source.id, kept.id)).counts.kept).toBe(
      1,
    );
    expect(
      (
        await f.request(
          `/api/files/${image.id}/replicas/${target.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "deleted",
    );
    expect(
      (await f.app.db.read((r) => r.replicas(image.id))).every(
        (r) => r.status === "deleted",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("cleanup snapshots, duplicate submission, backend batches, pagination and restart exclude later references and unregistered objects", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    expect(
      (
        await f.request(
          `/api/storage-sources/${source.id}/cleanups`,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    const preview = await (
      await f.request(`/api/storage-sources/${source.id}/cleanup-preview`)
    ).json();
    expect(preview.groups).toHaveLength(1);
    await remove();
    const base = (await f.app.db.read((r) => r.file(image.id)))!;
    const target = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id === source.id,
    )!;
    async function insert(count: number) {
      await f.app.db.transaction(async (r) => {
        for (let i = 0; i < count; i++) {
          const file = {
            ...base,
            ...entity(),
            logical_key: `snapshot/${crypto.randomUUID()}.png`,
            storage_key: crypto.randomUUID(),
          };
          await r.insertFile(file);
          await r.insertReplica({ ...target, ...entity(), file_id: file.id });
        }
      });
    }
    await insert(104);
    await Bun.write(join(f.root, "target", "unregistered.png"), f.png);
    const job = await f.app.cleanups.submit(source.id, "detach");
    expect((await f.app.cleanups.submit(source.id, "delete", false)).id).toBe(
      job.id,
    );
    await insert(1);
    await f.app.cleanups.tick();
    await f.restart();
    await f.app.cleanups.tick();
    await f.app.cleanups.tick();
    const detail = await f.app.cleanups.detail(source.id, job.id, 25, 100);
    expect(detail.job.status).toBe("finished");
    expect(detail.counts.success).toBe(105);
    expect(detail.items).toHaveLength(5);
    expect(detail.remaining).toBe(1);
    expect(
      await Bun.file(join(f.root, "target", "unregistered.png")).exists(),
    ).toBe(true);
    expect(
      (await f.request(`/api/storage-sources/${source.id}`, "DELETE")).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test("cleanup busy is retryable, deletion failure reuses original task and excludes retries while another mode is active", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await remove();
    const write = (await f.app.db.read((r) => r.tasks(image.id)))[0]!;
    await f.app.db.transaction(async (r) => {
      write.status = "running";
      await r.saveTask(write);
    });
    const job = await f.app.cleanups.submit(source.id);
    await f.app.cleanups.tick();
    expect(
      (await f.app.cleanups.detail(source.id, job.id)).items[0]!.error,
    ).toBe("BUSY");
    await f.app.db.transaction(async (r) => {
      write.status = "success";
      await r.saveTask(write);
    });
    const lease = f.app.plugins.acquire(source.id, "storage");
    const deletion = spyOn(lease.runtime, "delete").mockRejectedValue(
      new PluginError("FAILED", "failed", false),
    );
    await f.app.cleanups.retry(source.id, job.id);
    await complete(f);
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(task.status).toBe("failed");
    const detachJob = await f.app.cleanups.submit(source.id, "detach");
    await expect(f.app.cleanups.retry(source.id, job.id)).rejects.toThrow(
      "Another cleanup is active",
    );
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "failed",
    );
    await complete(f);
    expect(
      (await f.app.cleanups.detail(source.id, detachJob.id)).counts.success,
    ).toBe(1);
    deletion.mockRestore();
    await lease.release();
    expect(
      (await f.app.db.read((r) => r.tasks(image.id))).filter(
        (t) => t.kind === "delete",
      ),
    ).toHaveLength(1);
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("whole-image cleanup waits for all failed replicas across restart and retries original deletion tasks", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await remove();
    const other = (await f.app.db.read((r) => r.replicas(image.id))).find(
      (r) => r.storage_instance_id !== source.id,
    )!;
    await f.app.db.transaction(async (r) => {
      other.status = "write_failed";
      await r.saveReplica(other);
    });
    const lease = f.app.plugins.acquire(other.storage_instance_id, "storage");
    const fail = spyOn(lease.runtime, "delete").mockRejectedValue(
      new PluginError("FAILED", "failed", false),
    );
    const job = await f.app.cleanups.submit(source.id);
    await f.app.cleanups.tick();
    await f.app.files.sweep();
    // Simulate interruption before the item scope/result update was committed.
    await f.app.db.transaction(async (r) => {
      const item = (await r.cleanupItems(job.id, 1, 0))[0]!;
      item.whole_file = false;
      item.status = "pending";
      await r.saveCleanupItem(item);
    });
    fail.mockRestore();
    await lease.release();
    await f.restart();
    await f.app.cleanups.tick();
    const failed = await f.app.cleanups.detail(source.id, job.id);
    expect(failed.counts.failed).toBe(1);
    expect(failed.items[0]!.whole_file).toBe(true);
    expect(failed.remaining).toBe(0);
    await f.app.cleanups.retry(source.id, job.id);
    await complete(f);
    expect(
      (await f.app.cleanups.detail(source.id, job.id)).counts.success,
    ).toBe(1);
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "deleted",
    );
    expect(
      (await f.app.db.read((r) => r.tasks(image.id))).filter(
        (t) => t.kind === "delete",
      ),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("batch detach validates distinct bounded IDs and replica ownership and reports item errors", async () => {
  const f = await fixture();
  try {
    const a = await (await f.upload()).json(),
      b = await (await f.upload()).json();
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(a.id)))[0]!;
    expect(
      (
        await f.request(
          `/api/files/${b.id}/replicas/${replica.id}/detach`,
          "POST",
          { confirm: true },
        )
      ).status,
    ).toBe(404);
    for (const ids of [
      [a.id, a.id],
      Array.from({ length: 101 }, (_, i) => String(i)),
    ])
      expect(
        (
          await f.request("/api/files/batch-detach", "POST", {
            ids,
            confirm: true,
          })
        ).status,
      ).toBe(400);
    const result = await (
      await f.request("/api/files/batch-detach", "POST", {
        ids: [a.id, "missing"],
        sourceId: replica.storage_instance_id,
        confirm: true,
      })
    ).json();
    expect(result.results).toEqual([
      { id: a.id, accepted: true },
      { id: "missing", accepted: false, error: "NOT_FOUND" },
    ]);
  } finally {
    await f.close();
  }
});

test("cleanup remains active during automatic deletion retry and completes without manual retry", async () => {
  const { f, source, remove } = await setup();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    await remove();
    const lease = f.app.plugins.acquire(source.id, "storage");
    const deletion = spyOn(lease.runtime, "delete").mockRejectedValueOnce(
      new PluginError("FAILED", "transient", true),
    );
    const job = await f.app.cleanups.submit(source.id);
    await complete(f);
    const transient = await f.app.cleanups.detail(source.id, job.id);
    expect(transient.job.status).toBe("active");
    expect(transient.counts.running).toBe(1);
    expect(transient.counts.failed).toBe(0);
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(task.status).toBe("pending");
    await f.app.db.transaction((r) =>
      r.saveTask({ ...task, next_run_at: Date.now() }),
    );
    await complete(f);
    expect(
      (await f.app.cleanups.detail(source.id, job.id)).counts.success,
    ).toBe(1);
    expect((await f.app.db.read((r) => r.task(task.id)))!.attempts).toBe(2);
    deletion.mockRestore();
    await lease.release();
  } finally {
    await f.close();
  }
});

test("regular members cannot detach or submit source cleanups; invalid scope cannot become whole-image detach", async () => {
  const f = await fixture();
  try {
    const image = await (await f.upload()).json();
    await f.app.files.sweep();
    const replica = (await f.app.db.read((r) => r.replicas(image.id)))[0]!;
    expect(
      (
        await f.request("/api/files/batch-detach", "POST", {
          ids: [image.id],
          sourceId: "",
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `/api/storage-sources/${replica.storage_instance_id}/cleanups`,
          "POST",
          { mode: ["delete"] },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/api/users", "POST", {
          username: "cleanup-member",
          password: "member-password-123",
          role: "member",
          profileIds: [f.profileId],
        })
      ).status,
    ).toBe(201);
    const handle = handler(f.app);
    const login = await handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: "cleanup-member",
          password: "member-password-123",
        }),
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const info = await (
      await handle(
        new Request("http://localhost/api/auth/session", {
          headers: { cookie },
        }),
      )
    ).json();
    for (const path of [
      `/api/files/${image.id}/detach`,
      `/api/files/${image.id}/replicas/${replica.id}/detach`,
      "/api/files/batch-detach",
      `/api/storage-sources/${replica.storage_instance_id}/cleanups`,
    ]) {
      const response = await handle(
        new Request("http://localhost" + path, {
          method: "POST",
          headers: { cookie, "x-csrf-token": info.csrfToken },
          body: JSON.stringify({ ids: [image.id], confirm: true }),
        }),
      );
      expect(response.status).toBe(403);
    }
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "ready",
    );
  } finally {
    await f.close();
  }
});
