import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { PluginError } from "@picloom/plugin-sdk";
import { handler } from "../src/http/app";

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
    expect((await f.app.db.read((r) => r.file(image.id)))!.status).toBe(
      "deleted",
    );
  } finally {
    await f.close();
  }
});

test("termination requires admin, CSRF, confirmation and deletion failure, retaining records and objects", async () => {
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
    expect(await f.app.db.read((r) => r.file(image.id))).toMatchObject({
      status: "deleted",
    });
    expect(await f.app.db.read((r) => r.replica(replica.id))).toMatchObject({
      status: "deleted",
    });
    const failed = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(failed.status).toBe("failed");
    expect((await f.request(endpoint, "POST", { confirm: true })).status).toBe(
      200,
    );
    await expect(f.app.files.tasks.retry(failed.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await object.exists()).toBe(true);
    await f.app.files.sweep();
    expect((await f.request(`/api/files/${image.id}`)).status).toBe(200);
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
    expect((await f.app.db.read((r) => r.file(first.id)))?.status).toBe(
      "deleted",
    );
    expect((await f.app.db.read((r) => r.file(second.id)))?.status).toBe(
      "deleted",
    );
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await f.close();
  }
});
