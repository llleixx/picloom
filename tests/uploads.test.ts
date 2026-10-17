import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { runtimeDefaults } from "../shared/runtime-settings";

const create = async (
  f: Awaited<ReturnType<typeof fixture>>,
  size: number,
  token?: string,
) => {
  const response = await f.request(
    "/api/uploads",
    "POST",
    {
      profileId: f.profileId,
      size,
      name: "sample.png",
      params: { ignored: true },
    },
    token,
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    id: string;
    partSize: number;
    uploadKey: string;
  }>;
};
const put = (
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  index: number,
  bytes: Uint8Array,
  token?: string,
) =>
  handler(f.app)(
    new Request(`http://localhost/api/uploads/${id}/parts/${index}`, {
      method: "PUT",
      headers: { "x-upload-key": token ?? f.uploadKeys.get(id) ?? "" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
  );

test("parts can arrive out of order and be replaced; completion and restart never duplicate files", async () => {
  const f = await fixture();
  try {
    const bytes = new Uint8Array(runtimeDefaults.chunkPartBytes + 31);
    bytes.set(f.png);
    const upload = await create(f, bytes.length);
    expect(
      (await f.request(`/api/uploads/${upload.id}/complete`, "POST")).status,
    ).toBe(400);
    expect((await put(f, upload.id, 2, bytes.slice(0, 1))).status).toBe(400);
    expect(
      (await put(f, upload.id, 1, bytes.slice(upload.partSize + 1))).status,
    ).toBe(400);
    expect(
      (await put(f, upload.id, 1, bytes.slice(upload.partSize))).status,
    ).toBe(200);
    expect(
      (await put(f, upload.id, 0, bytes.slice(0, upload.partSize))).status,
    ).toBe(200);
    expect(
      (await put(f, upload.id, 0, bytes.slice(0, upload.partSize))).status,
    ).toBe(200);
    const responses = await Promise.all(
      [0, 1].map(() => f.request(`/api/uploads/${upload.id}/complete`, "POST")),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const result = await responses[0]!.json();
    expect(await responses[1]!.json()).toEqual(result);
    expect(await f.app.db.read((r) => r.countFiles())).toBe(1);
    expect(
      new Uint8Array(
        await (await f.request(new URL(result.url).pathname)).arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
    await f.app.db.transaction(async (r) => {
      const saved = (await r.uploadSession(upload.id))!;
      saved.status = "completing";
      await r.saveUploadSession(saved);
    });
    await f.restart();
    expect(
      await (
        await f.request(`/api/uploads/${upload.id}/complete`, "POST")
      ).json(),
    ).toEqual(result);
    expect(
      (await put(f, upload.id, 0, bytes.slice(0, upload.partSize))).status,
    ).toBe(409);
    await f.request(`/api/files/${result.id}`, "DELETE");
    expect(
      (await f.request(`/api/uploads/${upload.id}/complete`, "POST")).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test("sessions enforce upload keys, scope, quota, cancellation and expiry", async () => {
  const f = await fixture();
  try {
    const token = await (
      await f.request("/api/tokens", "POST", {
        name: "chunks",
        profileIds: [f.profileId],
      })
    ).json();
    expect(
      (
        await f.request(
          "/api/uploads",
          "POST",
          { profileId: crypto.randomUUID(), size: f.png.length },
          token.token,
        )
      ).status,
    ).toBe(403);
    const csrf = await handler(f.app)(
      new Request("http://localhost/api/uploads", {
        method: "POST",
        headers: { cookie: f.cookie },
        body: JSON.stringify({ profileId: f.profileId, size: f.png.length }),
      }),
    );
    expect(csrf.status).toBe(403);
    const a = await create(f, f.png.length, token.token);
    expect((await put(f, a.id, 0, f.png, token.token)).status).toBe(404);
    expect((await put(f, a.id, 0, f.png, a.uploadKey)).status).toBe(200);
    expect(
      (
        await f.request(
          `/api/uploads/${a.id}/complete`,
          "POST",
          undefined,
          token.token,
        )
      ).status,
    ).toBe(200);
    const b = await create(f, f.png.length);
    const oldCookie = f.cookie;
    await f.login();
    expect(f.cookie).not.toBe(oldCookie);
    expect((await put(f, b.id, 0, f.png)).status).toBe(200);
    f.app.config.uploadSessionLimit = 1;
    expect(
      (
        await f.request("/api/uploads", "POST", {
          profileId: f.profileId,
          size: f.png.length,
        })
      ).status,
    ).toBe(503);
    f.app.config.uploadSessionLimit = 100;
    f.app.config.uploadTempBytes = 1;
    expect(
      (
        await f.request("/api/uploads", "POST", {
          profileId: f.profileId,
          size: f.png.length,
        })
      ).status,
    ).toBe(503);
    f.app.config.uploadTempBytes = 1024 ** 3;
    const c = await create(f, f.png.length);
    await put(f, c.id, 0, f.png);
    expect((await f.request(`/api/uploads/${c.id}`, "DELETE")).status).toBe(
      200,
    );
    expect(await f.app.db.read((r) => r.uploadSession(c.id))).toBeNull();
    await f.app.db.transaction(async (r) => {
      const s = (await r.uploadSession(b.id))!;
      s.expires_at = 0;
      await r.saveUploadSession(s);
    });
    await f.app.uploads.cleanup(true);
    expect(await f.app.db.read((r) => r.uploadSession(b.id))).toBeNull();
    expect(
      (
        await f.request("/api/uploads", "POST", {
          profileId: f.profileId,
          size: f.app.config.maxUploadBytes + 1,
        })
      ).status,
    ).toBe(413);
    const d = await create(f, f.png.length, token.token);
    await f.request(`/api/tokens/${token.id}`, "DELETE");
    expect((await put(f, d.id, 0, f.png)).status).toBe(200);
    expect(
      (await f.request(`/api/uploads/${d.id}/complete`, "POST")).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});

test("failed publication and interrupted completion are cleaned and never replayed", async () => {
  let fail = true;
  const f = await fixture({
    beforeWrite: async () => {
      if (fail) throw new Error("injected");
    },
  });
  try {
    const a = await create(f, f.png.length);
    await put(f, a.id, 0, f.png);
    expect((await f.request(`/api/uploads/${a.id}/complete`, "POST")).ok).toBe(
      false,
    );
    expect((await f.app.db.read((r) => r.uploadSession(a.id)))!.status).toBe(
      "failed",
    );
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
    fail = false;
    const b = await create(f, f.png.length);
    await put(f, b.id, 0, f.png);
    await f.app.db.transaction(async (r) => {
      const s = (await r.uploadSession(b.id))!;
      s.status = "completing";
      await r.saveUploadSession(s);
    });
    const orphan = join(f.root, "uploads", crypto.randomUUID());
    await mkdir(orphan);
    await Bun.write(join(orphan, "0"), f.png);
    await f.restart();
    expect((await f.app.db.read((r) => r.uploadSession(b.id)))!.status).toBe(
      "failed",
    );
    expect(
      (await f.request(`/api/uploads/${b.id}/complete`, "POST")).status,
    ).toBe(409);
    expect(await f.app.db.read((r) => r.countFiles({ status: "ready" }))).toBe(
      0,
    );
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("expired session cleanup continues after deletion failure and retries without releasing its budget early", async () => {
  const f = await fixture();
  let removeSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const a = await create(f, f.png.length);
    const b = await create(f, f.png.length);
    await put(f, a.id, 0, f.png);
    await put(f, b.id, 0, f.png);
    const sessions = await f.app.db.read((r) => r.uploadSessions());
    // Fail the first session in the actual cleanup order.
    const failed = sessions[0]!;
    const other = sessions[1]!;
    await f.app.db.transaction(async (r) => {
      for (const session of sessions) {
        session.expires_at = 0;
        await r.saveUploadSession(session);
      }
    });
    const before = f.app.files.temporary.bytes;
    const retained = f.app.files.temporary.size("upload:" + failed.id);
    const path = join(f.root, "uploads", failed.id);
    const originalRemove = fs.rm;
    removeSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === path)
        throw Object.assign(new Error("Deletion denied"), { code: "EACCES" });
      return originalRemove(target, options);
    });
    await f.app.uploads.cleanup(true);
    expect(
      await f.app.db.read((r) => r.uploadSession(failed.id)),
    ).not.toBeNull();
    expect(await f.app.db.read((r) => r.uploadSession(other.id))).toBeNull();
    expect(await readdir(join(f.root, "uploads"))).toEqual([failed.id]);
    expect(f.app.files.temporary.bytes).toBe(retained);
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(before);
    removeSpy.mockRestore();
    removeSpy = undefined;
    await f.app.uploads.cleanup(true);
    expect(await f.app.db.read((r) => r.uploadSessions())).toEqual([]);
    expect(await readdir(join(f.root, "uploads"))).toEqual([]);
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    removeSpy?.mockRestore();
    await f.close();
  }
});
