import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { PluginError } from "@picloom/plugin-sdk";
import { handler } from "../src/http/app";
import { entity } from "../src/persistence/port";

test("list and detail distinguish retrying deletion from failure, and retry only unfinished cleanup", async () => {
  let fail = true;
  const f = await fixture({
    beforeDelete: async () => {
      if (fail) throw new PluginError("ACCESS_DENIED", "Denied", false);
    },
  });
  try {
    const image = await (await f.upload()).json();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    const detail = await (await f.request(`/api/files/${image.id}`)).json();
    const list = await (await f.request("/api/files")).json();
    expect(detail.status).toBe("delete_failed");
    expect(detail.error).toBe("DELETE_FAILED");
    expect(list.find((x: { id: string }) => x.id === image.id).error).toBe(
      detail.error,
    );
    const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    );
    expect(task!.status).toBe("failed");
    await f.app.files.tasks.retry(task!.id);
    expect(
      (await (await f.request(`/api/files/${image.id}`)).json()).error,
    ).toBeNull();
    expect((await (await f.request("/api/files")).json())[0].error).toBeNull();
    fail = false;
    await f.app.files.sweep();
    expect(await f.app.db.read((r) => r.file(image.id))).toBeNull();
  } finally {
    await f.close();
  }
});

test("termination requires admin, CSRF, confirmation and deletion failure, removing records while keeping objects", async () => {
  const f = await fixture({
    beforeDelete: async () => {
      throw new PluginError("ACCESS_DENIED", "Denied", false);
    },
  });
  try {
    const image = await (await f.upload()).json();
    const replica = (await f.app.db.read((r) => r.replicas(image.id)))[0]!;
    const endpoint = `/api/files/${image.id}/replicas/${replica.id}/terminate`;
    expect((await f.request(endpoint, "POST", { confirm: true })).status).toBe(
      409,
    );
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    const file = (await f.app.db.read((r) => r.file(image.id)))!;
    const object = Bun.file(join(f.root, "originals", file.storage_key));
    expect(await object.exists()).toBe(true);
    expect((await f.request(endpoint, "POST", {})).status).toBe(400);
    expect(
      (
        await handler(f.app)(
          new Request("http://localhost" + endpoint, {
            method: "POST",
            headers: { cookie: f.cookie },
            body: JSON.stringify({ confirm: true }),
          }),
        )
      ).status,
    ).toBe(403);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request(endpoint, "POST", { confirm: true }, token.token))
        .status,
    ).toBe(403);
    // A regular member session must not be able to abandon cleanup either.
    const owner = await f.app.auth.authenticate(
      new Request("http://localhost", { headers: { cookie: f.cookie } }),
      false,
    );
    await f.app.db.transaction(async (r) => {
      const user = (await r.user(owner.user.id))!;
      user.role = "member";
      await r.updateUser(user.id, user.role, user.status);
    });
    expect((await f.request(endpoint, "POST", { confirm: true })).status).toBe(
      403,
    );
    await f.app.db.transaction(async (r) => {
      const user = (await r.user(owner.user.id))!;
      user.role = "owner";
      await r.updateUser(user.id, user.role, user.status);
    });
    expect((await f.request(endpoint, "POST", { confirm: true })).status).toBe(
      200,
    );
    expect(await f.app.db.read((r) => r.file(image.id))).toBeNull();
    expect(await f.app.db.read((r) => r.replica(replica.id))).toBeNull();
    expect(await f.app.db.read((r) => r.tasks(image.id))).toEqual([]);
    expect((await f.request(endpoint, "POST", { confirm: true })).status).toBe(
      404,
    );
    expect(await object.exists()).toBe(true);
    await f.app.files.sweep();
    expect((await f.request(`/api/files/${image.id}`)).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("termination rejects running deletion while unrelated files continue", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture({
    beforeDelete: async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
        throw new PluginError("ACCESS_DENIED", "Denied", false);
      }
    },
  });
  try {
    const first = await (await f.upload()).json(),
      second = await (await f.upload()).json();
    const replica = (await f.app.db.read((r) => r.replicas(first.id)))[0]!;
    await f.app.files.delete(first.id);
    await f.app.files.tasks.cleanupPending();
    await f.app.files.tasks.dispatch();
    await entered.promise;
    await expect(
      f.app.files.terminateReplica(first.id, replica.id),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.app.files.delete(second.id);
    await f.app.files.tasks.cleanupPending();
    await f.app.files.tasks.dispatch();
    release.resolve();
    await f.app.files.sweep();
    await f.app.files.terminateReplica(first.id, replica.id);
    expect(await f.app.db.read((r) => r.file(first.id))).toBeNull();
    expect(await f.app.db.read((r) => r.file(second.id))).toBeNull();
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await f.close();
  }
});

test.each(["delete", "detach", "terminate"] as const)(
  "%s removes image-owned records and preserves shared definitions",
  async (mode) => {
    const f = await fixture({
      beforeDelete: async () => {
        if (mode === "terminate")
          throw new PluginError("ACCESS_DENIED", "Denied", false);
      },
    });
    try {
      const image = await (await f.upload()).json();
      const file = (await f.app.db.read((r) => r.file(image.id)))!;
      const replica = (await f.app.db.read((r) => r.replicas(image.id)))[0]!;
      const taskIds = (await f.app.db.read((r) => r.tasks(image.id))).map(
        (t) => t.id,
      );
      const tag = {
        ...entity(),
        owner_id: file.owner_id!,
        name: "Shared",
        name_key: "shared",
      };
      const collection = { ...tag, ...entity(), description: "" };
      const job = {
        ...entity(),
        source_id: replica.storage_instance_id,
        mode: "delete" as const,
        include_last: true,
        status: "active" as const,
      };
      const upload = await (
        await f.request("/api/uploads", "POST", {
          profileId: f.profileId,
          size: f.png.length,
          name: "sample.png",
        })
      ).json();
      await f.app.db.transaction(async (r) => {
        const session = (await r.uploadSession(upload.id))!;
        await r.saveUploadSession({
          ...session,
          file_id: image.id,
          status: "completed",
        });
        await r.insertTag(tag);
        await r.insertCollection(collection);
        await r.replaceFileTags(image.id, [tag.id]);
        await r.replaceFileCollections(image.id, [collection.id]);
        await r.insertCleanupJob(job);
        await r.insertCleanupItem({
          ...entity(),
          job_id: job.id,
          file_id: image.id,
          replica_id: replica.id,
          status: "running",
          whole_file: true,
          error: null,
        });
      });
      const staleJob = (await f.app.db.read((r) => r.cleanupJob(job.id)))!;
      if (mode === "delete") {
        await expect(
          f.app.db.transaction(async (r) => {
            await r.deleteFile(image.id);
            throw new Error("Rollback cleanup");
          }),
        ).rejects.toThrow("Rollback cleanup");
        expect(
          (await f.app.db.read((r) => r.cleanupCounts(job.id))).success,
        ).toBe(0);
        expect(await f.app.db.read((r) => r.file(image.id))).not.toBeNull();
      }
      if (mode === "detach") await f.app.files.detach(image.id);
      else {
        await f.app.files.delete(image.id);
        await f.app.files.sweep();
        if (mode === "terminate")
          await f.app.files.terminateReplica(image.id, replica.id);
      }
      await f.app.db.read(async (r) => {
        expect(await r.file(image.id)).toBeNull();
        expect(await r.replicas(image.id)).toEqual([]);
        expect(await r.tasks(image.id)).toEqual([]);
        for (const id of taskIds) expect(await r.task(id)).toBeNull();
        expect(await r.uploadSession(upload.id)).toBeNull();
        expect(await r.cleanupItems(job.id, 10, 0)).toEqual([]);
        expect((await r.cleanupCounts(job.id)).success).toBe(1);
        expect((await r.fileTags([image.id])).get(image.id) ?? []).toEqual([]);
        expect(
          (await r.fileCollections([image.id])).get(image.id) ?? [],
        ).toEqual([]);
        expect(await r.tag(tag.id)).toEqual(tag);
        expect(await r.collection(collection.id)).toEqual(collection);
        expect(await r.instance(replica.storage_instance_id)).not.toBeNull();
        expect(await r.profile(f.profileId)).not.toBeNull();
      });
      expect((await f.request(`/api/files/${image.id}`)).status).toBe(404);
      await f.app.cleanups.tick();
      expect((await f.app.db.read((r) => r.cleanupJob(job.id)))!.status).toBe(
        "finished",
      );
    } finally {
      await f.close();
    }
  },
);

test("terminal cleanup retries after cache removal fails", async () => {
  const f = await fixture();
  const remove = spyOn(f.app.files.cache, "remove").mockRejectedValueOnce(
    new Error("Cache unavailable"),
  );
  try {
    const image = await (await f.upload()).json();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "deleted",
    );
    await f.app.files.sweep();
    expect(await f.app.db.read((r) => r.file(image.id))).toBeNull();
    expect(await f.app.db.read((r) => r.tasks(image.id))).toEqual([]);
  } finally {
    remove.mockRestore();
    await f.close();
  }
});
