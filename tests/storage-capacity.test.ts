import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { checkStorageCapacity } from "../src/core/storage-capacity";

async function limit(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: number | null,
) {
  const source = (await f.app.plugins.storageViews())[0]!;
  const response = await f.request(`/api/storage-sources/${source.id}`, "PUT", {
    ...source,
    maxStorageBytes: bytes,
    expectedVersion: source.configVersion,
  });
  expect(response.status).toBe(200);
  expect((await response.json()).maxStorageBytes).toBe(bytes);
  return source.id;
}

test("capacity admits exact fit, blocks excess, persists and can be cleared", async () => {
  const f = await fixture();
  try {
    const id = await limit(f, f.png.length);
    expect((await f.upload()).ok).toBe(true);
    expect(await f.app.db.read((r) => r.storageUsedBytes(id))).toBe(
      f.png.length,
    );
    expect((await f.upload()).ok).toBe(false);
    await f.restart();
    expect((await f.app.plugins.view(id)).maxStorageBytes).toBe(f.png.length);
    await limit(f, null);
    expect((await f.upload()).ok).toBe(true);
  } finally {
    await f.close();
  }
});

test("in-flight writes reserve capacity and deleted replicas release it", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture({
    beforeWrite: async () => {
      entered();
      await gate;
    },
  });
  try {
    const id = await limit(f, f.png.length);
    expect(await f.app.plugins.view(id)).toMatchObject({
      usedStorageBytes: 0,
      reservedStorageBytes: 0,
    });
    const upload = f.upload();
    await started;
    const response = await f.request("/api/storage-sources");
    expect(
      (await response.json()).find(
        (source: { id: string }) => source.id === id,
      ),
    ).toMatchObject({
      usedStorageBytes: 0,
      reservedStorageBytes: f.png.length,
    });
    expect((await f.upload()).ok).toBe(false);
    release();
    const result = await upload;
    expect(result.ok).toBe(true);
    const file = await result.json();
    expect(await f.app.plugins.view(id)).toMatchObject({
      usedStorageBytes: f.png.length,
      reservedStorageBytes: 0,
    });
    await f.app.db.transaction(async (r) => {
      const replica = (await r.replicas(file.id))[0]!;
      replica.status = "delete_pending";
      await r.saveReplica(replica);
      expect(await r.storageUsedBytes(id)).toBe(f.png.length);
      expect((await r.storageUsage([id])).get(id)).toEqual({
        used: f.png.length,
        reserved: 0,
      });
      replica.status = "deleted";
      await r.saveReplica(replica);
      expect(await r.storageUsedBytes(id)).toBe(0);
      expect((await r.storageUsage([id])).get(id)).toBeUndefined();
      await checkStorageCapacity(r, id, f.png.length);
    });
  } finally {
    release();
    await f.close();
  }
});

test("capacity rejects invalid values and rechecks lowered limits for pending writes", async () => {
  const f = await fixture();
  try {
    const source = (await f.app.plugins.storageViews())[0]!;
    for (const value of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
      const response = await f.request(
        `/api/storage-sources/${source.id}`,
        "PUT",
        {
          ...source,
          maxStorageBytes: value,
          expectedVersion: source.configVersion,
        },
      );
      expect(response.status).toBe(400);
    }
    await limit(f, null);
    const response = await f.upload();
    expect(response.ok).toBe(true);
    const file = await response.json();
    await limit(f, f.png.length - 1);
    await expect(
      f.app.db.transaction(async (r) => {
        const replica = (await r.replicas(file.id))[0]!;
        await checkStorageCapacity(r, source.id, f.png.length, replica.id);
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CAPACITY_EXCEEDED" });
  } finally {
    await f.close();
  }
});

test("full sources are skipped and background writes obey a lowered limit", async () => {
  const f = await fixture();
  try {
    const first = (await f.app.plugins.storageViews())[0]!;
    const created = await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Second",
      config: { root: `${f.root}/second` },
      maxStorageBytes: f.png.length,
    });
    expect(created.status).toBe(201);
    const second = await created.json();
    expect(second.maxStorageBytes).toBe(f.png.length);
    const profile = await f.app.configuration.profile(f.profileId);
    let group = await f.app.configuration.group(profile.storageGroupId);
    group = await f.app.configuration.saveGroup(
      {
        ...group,
        selectionStrategy: "priority",
        redundancyCount: 1,
        members: [
          { instanceId: first.id, weight: 1 },
          { instanceId: second.id, weight: 1 },
        ],
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    const response = await f.upload();
    expect(response.ok).toBe(true);
    const file = await response.json();
    const edited = await f.request(`/api/storage-sources/${second.id}`, "PUT", {
      ...second,
      maxStorageBytes: 1,
      expectedVersion: second.configVersion,
    });
    expect(edited.ok).toBe(true);
    await f.app.files.sweep();
    const replicas = await f.app.db.read((r) => r.replicas(file.id));
    expect(
      replicas.find((r) => r.storage_instance_id === second.id)?.status,
    ).toBe("write_failed");
    const tasks = await f.app.db.read((r) => r.tasks(file.id));
    expect(tasks.find((t) => t.kind === "write")?.last_error).toBe(
      "STORAGE_CAPACITY_EXCEEDED",
    );
    await f.app.configuration.saveGroup(
      {
        ...group,
        redundancyCount: 0,
        members: [
          { instanceId: second.id, weight: 1 },
          { instanceId: first.id, weight: 1 },
        ],
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    const next = await f.upload();
    expect(next.ok).toBe(true);
    const nextFile = await next.json();
    expect(
      (await f.app.db.read((r) => r.replicas(nextFile.id)))[0]!
        .storage_instance_id,
    ).toBe(first.id);
  } finally {
    await f.close();
  }
});
