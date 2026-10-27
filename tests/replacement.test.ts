import { expect, test } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";

test("cross-format replacement preserves the public link despite ended replica failure and cleans only the old objects", async () => {
  const f = await fixture();
  try {
    const old = await (await f.upload()).json();
    const bytes = await sharp(f.png).resize(12, 6).jpeg().toBuffer();
    const next = await (await f.upload(undefined, bytes, "new.jpg")).json();
    await f.app.files.sweep();
    const source = await (
      await f.request("/api/storage-sources", "POST", {
        pluginId: "builtin.local",
        version: "1.0.0",
        name: "Removed copy",
        config: { root: `${f.root}/removed-copy` },
      })
    ).json();
    await f.app.db.transaction(async (r) => {
      const replica = {
        ...(await r.replicas(old.id))[0]!,
        id: crypto.randomUUID(),
        storage_instance_id: source.id,
        status: "deleted" as const,
      };
      await r.insertReplica(replica);
      await r.insertTask({
        ...(await r.tasks(old.id))[0]!,
        id: crypto.randomUUID(),
        replica_id: replica.id,
        kind: "delete",
        status: "failed",
        last_error: "DELETE_FAILED",
      });
    });
    const before = (await f.app.db.read((r) => r.file(old.id)))!;
    const payload = {
      replacementId: next.id,
      replacementPath: new URL(next.url).pathname,
    };
    const responses = await Promise.all([
      f.request(`/api/files/${old.id}/replace`, "POST", payload),
      f.request(`/api/files/${old.id}/replace`, "POST", payload),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const result = await responses.find((r) => r.ok)!.json();
    expect(result).toEqual({ id: next.id, url: old.url });
    expect((await f.app.db.read((r) => r.file(old.id)))!.storage_key).toBe(
      before.storage_key,
    );
    await f.app.files.sweep();
    expect(await f.app.db.read((r) => r.file(old.id))).toBeNull();
    const response = await f.request(new URL(old.url).pathname);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const replacement = (await f.app.db.read((r) => r.file(next.id)))!;
    expect(replacement.mime_type).toBe("image/jpeg");
    expect([replacement.width, replacement.height]).toEqual([12, 6]);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await f.request(new URL(next.url).pathname)).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("replacement rejects unsettled tasks, stale paths, and another user's image", async () => {
  const f = await fixture();
  try {
    const old = await (await f.upload()).json();
    const next = await (await f.upload()).json();
    await f.app.files.sweep();
    const replace = (
      candidate: typeof next,
      path = new URL(candidate.url).pathname,
    ) =>
      f.request(`/api/files/${old.id}/replace`, "POST", {
        replacementId: candidate.id,
        replacementPath: path,
      });
    expect((await replace(next, "/stale.png")).status).toBe(409);
    await f.app.db.transaction(async (r) => {
      const replicas = await r.replicas(next.id);
      replicas[0]!.status = "write_failed";
      await r.saveReplica(replicas[0]!);
    });
    expect((await replace(next)).status).toBe(409);
    await f.app.db.transaction(async (r) => {
      const replicas = await r.replicas(next.id);
      replicas[0]!.status = "ready";
      await r.saveReplica(replicas[0]!);
      const oldFile = (await r.file(old.id))!;
      const user = (await r.user(oldFile.owner_id!))!;
      await r.updateUser(user.id, "member", user.status);
      oldFile.owner_id = null;
      await r.saveFile(oldFile, "ready");
    });
    expect((await replace(next)).status).toBe(404);
    const response = await f.request(new URL(old.url).pathname);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect((await f.app.db.read((r) => r.file(next.id)))!.status).toBe("ready");
  } finally {
    await f.close();
  }
});
