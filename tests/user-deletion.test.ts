import { expect, test } from "bun:test";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fixture } from "./helpers";
import { hash, type Identity } from "../src/core/auth";
import { handler } from "../src/http/app";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function identity(f: Fixture, username = "admin") {
  const login = await f.app.auth.login(username, "test-password-123", username);
  return f.app.db.read((r) =>
    f.app.auth.verify(r, "session", hash(login.secret)),
  );
}
async function user(
  f: Fixture,
  actor: Identity,
  username: string,
  role = "member",
) {
  const { id } = await f.app.auth.saveUser(actor, {
    username,
    password: "test-password-123",
    role,
    profileIds: [f.profileId],
  });
  return { id, actor: await identity(f, username) };
}

test("deleting an account clears personal data and credentials, retaining images and historical IDs", async () => {
  const f = await fixture();
  try {
    const owner = await identity(f);
    const alice = await user(f, owner, "alice");
    const token = await f.app.auth.token(alice.actor, "upload");
    const tag = await f.app.files.organization.createTag(alice.actor, {
      name: "private",
    });
    const collection = await f.app.files.organization.createCollection(
      alice.actor,
      { name: "album" },
    );
    const uploaded = await (await f.upload(token.token)).json();
    await f.app.db.transaction(async (r) => {
      await r.replaceFileTags(uploaded.id, [tag.id]);
      await r.replaceFileCollections(uploaded.id, [collection.id]);
    });
    const before = await f.app.db.read(async (r) => ({
      file: await r.file(uploaded.id),
      replicas: await r.replicas(uploaded.id),
      tasks: await r.tasks(uploaded.id),
    }));
    const pending = await (
      await f.request(
        "/api/uploads",
        "POST",
        {
          profileId: f.profileId,
          size: f.png.length,
        },
        token.token,
      )
    ).json();
    expect(
      (
        await handler(f.app)(
          new Request(`http://localhost/api/uploads/${pending.id}/parts/0`, {
            method: "PUT",
            headers: { "x-upload-key": pending.uploadKey },
            body: new Uint8Array(f.png),
          }),
        )
      ).status,
    ).toBe(200);
    const response = await f.request(`/api/users/${alice.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await f.app.db.read(async (r) => {
      expect(await r.user(alice.id)).toBeNull();
      expect(await r.credential("session", alice.actor.hash)).toBeNull();
      expect(await r.tokenById(token.id)).toBeNull();
      expect(await r.userProfiles(alice.id)).toEqual([]);
      expect(await r.tag(tag.id)).toBeNull();
      expect(await r.collection(collection.id)).toBeNull();
      expect(await r.fileTags([uploaded.id])).toEqual(new Map());
      expect(await r.fileCollections([uploaded.id])).toEqual(new Map());
      expect(
        await r.dailyUploadCount(
          "u:" + alice.id,
          new Date().toISOString().slice(0, 10),
        ),
      ).toBe(0);
      expect(await r.file(uploaded.id)).toEqual(before.file);
      expect(await r.replicas(uploaded.id)).toEqual(before.replicas);
      expect(await r.tasks(uploaded.id)).toEqual(before.tasks);
      expect(await r.uploadSession(pending.id)).toBeNull();
      expect(await r.profile(f.profileId)).not.toBeNull();
    });
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
    expect(f.app.files.temporary.size("upload:" + pending.id)).toBe(0);
    expect((await f.upload(token.token)).status).toBe(401);
    await expect(
      f.app.auth.login("alice", "test-password-123", "again"),
    ).rejects.toMatchObject({ status: 401 });
    const detail = await (await f.request(`/api/files/${uploaded.id}`)).json();
    expect(detail).toMatchObject({
      ownerId: alice.id,
      ownerName: null,
      origin: { kind: "upload", userId: alice.id, userName: null },
      tags: [],
      collections: [],
    });
    expect(
      new Uint8Array(
        await (await f.request(new URL(uploaded.url).pathname)).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array(f.png));
    const recreated = await user(f, owner, "alice");
    expect(recreated.id).not.toBe(alice.id);
    expect(
      await f.app.db.read((r) => r.countFiles({ ownerId: recreated.id })),
    ).toBe(0);
    await expect(
      f.app.files.organization.createTag(owner, {
        name: "new",
        ownerId: alice.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const scope = f.app.files.organization.scope(alice.id);
    await expect(
      scope.ensureTag({ name: "late" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      scope.ensureCollection({ name: "late" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.request(`/api/files/${uploaded.id}`, "DELETE")).status,
    ).toBe(202);
    await f.app.files.sweep();
  } finally {
    await f.close();
  }
});

test("deletion enforces the user role boundary and checks current credentials", async () => {
  const f = await fixture();
  try {
    const owner = await identity(f);
    const manager = await user(f, owner, "manager", "admin");
    const peer = await user(f, owner, "peer", "admin");
    const member = await user(f, owner, "member");
    await expect(
      f.app.auth.deleteUser(owner, owner.user.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.app.auth.deleteUser(manager.actor, peer.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.app.auth.deleteUser(manager.actor, manager.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.app.auth.deleteUser(member.actor, peer.id),
    ).rejects.toMatchObject({ status: 403 });
    await f.app.auth.deleteUser(manager.actor, member.id);
    await f.app.auth.deleteUser(owner, manager.id);
    await expect(
      f.app.auth.deleteUser(manager.actor, peer.id),
    ).rejects.toMatchObject({ status: 401 });
    expect((await f.request("/api/users/missing", "DELETE")).status).toBe(404);
    const noCsrf = await handler(f.app)(
      new Request(`http://localhost/api/users/${peer.id}`, {
        method: "DELETE",
        headers: { cookie: f.cookie },
      }),
    );
    expect(noCsrf.status).toBe(403);
    const token = await f.app.auth.token(owner, "owner token");
    expect(
      (
        await f.request(
          `/api/users/${peer.id}`,
          "DELETE",
          undefined,
          token.token,
        )
      ).status,
    ).toBe(403);
    expect((await f.request(`/api/users/${peer.id}`, "DELETE")).status).toBe(
      200,
    );
  } finally {
    await f.close();
  }
});

test("imported images retain their required origin ID after deleting the importer", async () => {
  const f = await fixture();
  try {
    const owner = await identity(f);
    const importer = await user(f, owner, "importer", "admin");
    const source = await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "legacy",
      config: { root: join(f.root, "legacy") },
    });
    await Bun.write(join(f.root, "legacy/image.png"), f.png);
    const result = await f.app.imports.page(
      source.id,
      { publicPrefix: "/legacy/", mimeTypes: ["image/png"] },
      importer.id,
      {
        signal: AbortSignal.timeout(10000),
        requestId: "delete-importer",
        log() {},
      },
    );
    expect(result.imported).toBe(1);
    const file = (
      await f.app.db.read((r) => r.files(30, 0, { ownerId: importer.id }))
    )[0]!;
    await expect(
      f.app.db.transaction((r) =>
        r.insertFile({
          ...file,
          id: crypto.randomUUID(),
          logical_key: "invalid.png",
          origin_user_id: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.request(`/api/users/${importer.id}`, "DELETE");
    const response = await f.request(`/api/files/${file.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownerId: importer.id,
      ownerName: null,
      origin: { kind: "import", userId: importer.id, userName: null },
    });
    const publicImage = await f.request("/legacy/image.png");
    expect(publicImage.status).toBe(200);
    await publicImage.arrayBuffer();
  } finally {
    await f.close();
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("admitted multipart upload finishes after deletion without restoring expiry or daily usage", async () => {
  const entered = gate(),
    proceed = gate();
  const f = await fixture({
    async beforePublish() {
      entered.release();
      await proceed.promise;
    },
  });
  let completion: Promise<Response> | undefined;
  try {
    const owner = await identity(f);
    const alice = await user(f, owner, "alice");
    const token = await f.app.auth.token(alice.actor, "upload");
    const pending = await (
      await f.request(
        "/api/uploads",
        "POST",
        { profileId: f.profileId, size: f.png.length },
        token.token,
      )
    ).json();
    await handler(f.app)(
      new Request(`http://localhost/api/uploads/${pending.id}/parts/0`, {
        method: "PUT",
        headers: { "x-upload-key": pending.uploadKey },
        body: new Uint8Array(f.png),
      }),
    );
    completion = f.request(`/api/uploads/${pending.id}/complete`, "POST");
    await entered.promise;
    expect((await f.request(`/api/users/${alice.id}`, "DELETE")).status).toBe(
      200,
    );
    proceed.release();
    const result = await completion;
    expect(result.status).toBe(200);
    const uploaded = await result.json();
    await f.app.db.read(async (r) => {
      expect(await r.file(uploaded.id)).toMatchObject({
        status: "ready",
        owner_id: alice.id,
        origin_user_id: alice.id,
      });
      expect(
        (await r.uploadSession(pending.id))!.expires_at,
      ).toBeLessThanOrEqual(Date.now());
      expect(
        await r.dailyUploadCount(
          "u:" + alice.id,
          new Date().toISOString().slice(0, 10),
        ),
      ).toBe(0);
    });
    expect(
      (await f.request(`/api/uploads/${pending.id}/complete`, "POST")).status,
    ).toBe(410);
    await f.app.uploads.cleanup(true);
    expect(await f.app.db.read((r) => r.uploadSession(pending.id))).toBeNull();
  } finally {
    proceed.release();
    await completion;
    await f.close();
  }
});

test("replacement preserves distinct owner and uploader IDs when either account is deleted", async () => {
  const f = await fixture();
  try {
    const owner = await identity(f);
    const alice = await user(f, owner, "alice");
    const bob = await user(f, owner, "bob");
    const aToken = await f.app.auth.token(alice.actor, "a");
    const bToken = await f.app.auth.token(bob.actor, "b");
    const old = await (await f.upload(aToken.token)).json();
    const next = await (await f.upload(bToken.token)).json();
    await f.app.files.replace(
      old.id,
      next.id,
      new URL(next.url).pathname,
      owner,
    );
    await f.request(`/api/users/${bob.id}`, "DELETE");
    let detail = await (await f.request(`/api/files/${next.id}`)).json();
    expect(detail).toMatchObject({
      ownerId: alice.id,
      ownerName: "alice",
      origin: { userId: bob.id, userName: null },
    });
    await f.request(`/api/users/${alice.id}`, "DELETE");
    detail = await (await f.request(`/api/files/${next.id}`)).json();
    expect(detail).toMatchObject({
      ownerId: alice.id,
      ownerName: null,
      origin: { userId: bob.id, userName: null },
    });
  } finally {
    await f.close();
  }
});

test("image owner options include distinct deleted owners with images and search by historical ID", async () => {
  const f = await fixture();
  try {
    const owner = await identity(f);
    const alice = await user(f, owner, "alice");
    const empty = await user(f, owner, "empty");
    const token = await f.app.auth.token(alice.actor, "upload");
    const image = await (await f.upload(token.token)).json();
    expect((await f.upload(token.token)).ok).toBe(true);
    let response = await f.request("/api/files/owners?q=ALICE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: alice.id, name: "alice" }]);
    await expect(f.app.files.owners(alice.actor, 30, "")).rejects.toMatchObject(
      { status: 403 },
    );
    await f.request(`/api/users/${alice.id}`, "DELETE");
    await f.request(`/api/users/${empty.id}`, "DELETE");
    const options = await (await f.request("/api/files/owners")).json();
    expect(
      options.filter((item: { id: string }) => item.id === alice.id),
    ).toEqual([{ id: alice.id, name: alice.id }]);
    expect(options.some((item: { id: string }) => item.id === empty.id)).toBe(
      false,
    );
    response = await f.request(
      "/api/files/owners?q=" + alice.id.slice(0, 12).toUpperCase(),
    );
    expect(await response.json()).toEqual([{ id: alice.id, name: alice.id }]);
    expect(await (await f.request("/api/files/owners?q=alice")).json()).toEqual(
      [],
    );
    expect(
      (await (await f.request("/api/files?owner=" + alice.id)).json()).map(
        (item: { id: string }) => item.id,
      ),
    ).toContain(image.id);
    expect((await f.request("/api/files/owners?limit=0")).status).toBe(400);
    expect(
      (await (await f.request("/api/users")).json()).items.some(
        (item: { id: string }) => item.id === alice.id,
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
