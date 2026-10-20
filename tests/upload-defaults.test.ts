import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
async function secondProfile(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await f.app.configuration.profileEditor(f.profileId);
  return f.app.configuration.saveProfileEditor({
    ...p,
    name: "Other",
    path: { ...p.path, key: undefined },
  });
}
async function defaults(
  f: Awaited<ReturnType<typeof fixture>>,
  token?: string,
) {
  return (
    await f.request("/api/upload-defaults", "GET", undefined, token)
  ).json();
}
test("upload defaults resolve explicit, personal and site selection and pin chunk sessions", async () => {
  const f = await fixture();
  try {
    const other = await secondProfile(f);
    expect((await defaults(f)).defaultProfileId).toBe(f.profileId);
    expect(
      (
        await f.request("/api/auth/upload-default", "PUT", {
          profileId: other.id,
        })
      ).status,
    ).toBe(200);
    expect((await defaults(f)).defaultProfileId).toBe(other.id);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(f.png)], "image.png"));
    const uploaded = await f.request("/api/files", "POST", form);
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json();
    expect(
      (await f.app.db.read((r) => r.file(file.id)))?.upload_profile_id,
    ).toBe(other.id);
    const created = await f.request("/api/uploads", "POST", {
      size: f.png.byteLength,
    });
    expect(created.status).toBe(201);
    const session = await created.json();
    await f.request("/api/auth/upload-default", "PUT", { profileId: null });
    expect(
      (await f.app.db.read((r) => r.uploadSession(session.id)))?.profile_id,
    ).toBe(other.id);
    expect((await defaults(f)).defaultProfileId).toBe(f.profileId);
    for (const profileId of ["", null, "does-not-exist"]) {
      expect(
        (await f.request("/api/uploads", "POST", { size: 10, profileId }))
          .status,
      ).not.toBe(201);
    }
    await f.restart();
    expect((await defaults(f)).defaultProfileId).toBe(f.profileId);
  } finally {
    await f.close();
  }
});
test("default selection respects token scopes, disabled profiles and guest permissions", async () => {
  const f = await fixture();
  try {
    const other = await secondProfile(f);
    await f.request("/api/auth/upload-default", "PUT", { profileId: other.id });
    const token = await (
      await f.request("/api/tokens", "POST", {
        name: "scoped",
        profileIds: [f.profileId],
      })
    ).json();
    expect((await defaults(f, token.token)).defaultProfileId).toBe(other.id);
    expect(
      (
        await f.request(
          "/api/uploads",
          "POST",
          { size: 10, profileId: other.id },
          token.token,
        )
      ).status,
    ).toBe(403);
    const current = await f.app.configuration.profileEditor(other.id);
    await f.app.configuration.saveProfileEditor(
      { ...current, enabled: false, expectedVersion: current.configVersion },
      other.id,
    );
    expect((await defaults(f)).defaultProfileId).toBe(other.id);
    expect(
      (await f.request("/api/uploads", "POST", { size: 10 })).status,
    ).not.toBe(201);
    const guest = await handler(f.app)(
      new Request("http://localhost/api/upload-defaults"),
    );
    expect((await guest.json()).defaultProfileId).toBe(f.profileId);
    await f.request("/api/site-upload-default", "PUT", { profileId: null });
    const missing = await f.request(
      "/api/uploads",
      "POST",
      { size: 10 },
      token.token,
    );
    expect((await missing.json()).error.code).toBe("FORBIDDEN");
  } finally {
    await f.close();
  }
});
test("changing site default is exclusive and deleted personal defaults remain explicit failures", async () => {
  const f = await fixture();
  try {
    const other = await secondProfile(f);
    await f.request("/api/site-upload-default", "PUT", { profileId: other.id });
    await f.request("/api/auth/upload-default", "PUT", { profileId: other.id });
    expect(
      (await f.app.db.read((r) => r.profiles()))
        .filter((p) => p.is_default)
        .map((p) => p.id),
    ).toEqual([other.id]);
    await f.app.configuration.deleteProfile(other.id);
    expect(await defaults(f)).toEqual({
      defaultProfileId: other.id,
      userDefaultProfileId: other.id,
      siteDefaultProfileId: null,
    });
    expect((await f.request("/api/uploads", "POST", { size: 10 })).status).toBe(
      403,
    );
  } finally {
    await f.close();
  }
});

test("changing site default does not invalidate an in-flight upload or get overwritten by an editor", async () => {
  let unblock!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const f = await fixture({
    beforeWrite: async () => {
      started();
      await hold;
    },
  });
  try {
    const other = await secondProfile(f);
    const stale = (await f.app.db.read((r) => r.profile(other.id)))!;
    const pending = f.upload();
    await waiting;
    try {
      expect(
        (
          await f.request("/api/site-upload-default", "PUT", {
            profileId: other.id,
          })
        ).status,
      ).toBe(200);
    } finally {
      unblock();
    }
    expect((await pending).status).toBe(201);
    await f.app.db.transaction((r) =>
      r.saveProfile(
        { ...stale, name: "Edited", config_version: stale.config_version + 1 },
        stale.config_version,
      ),
    );
    expect((await defaults(f)).siteDefaultProfileId).toBe(other.id);
  } finally {
    unblock();
    await f.close();
  }
});

test("members cannot set site defaults; revoked grants fail without falling back", async () => {
  const f = await fixture();
  try {
    const other = await secondProfile(f);
    const member = await (
      await f.request("/api/users", "POST", {
        username: "member",
        password: "member-password",
        role: "member",
        profileIds: [f.profileId, other.id],
      })
    ).json();
    const handle = handler(f.app);
    const login = await handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "member",
          password: "member-password",
        }),
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (
      await handle(
        new Request("http://localhost/api/auth/session", {
          headers: { cookie },
        }),
      )
    ).json();
    const request = (path: string, method = "GET", value?: unknown) =>
      handle(
        new Request("http://localhost" + path, {
          method,
          headers: {
            cookie,
            "x-csrf-token": session.csrfToken,
            "content-type": "application/json",
          },
          body: value === undefined ? undefined : JSON.stringify(value),
        }),
      );
    expect(
      (
        await request("/api/site-upload-default", "PUT", {
          profileId: other.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/auth/upload-default", "PUT", {
          profileId: other.id,
        })
      ).status,
    ).toBe(200);
    await f.app.db.transaction((r) =>
      r.replaceUserProfiles(member.id, [f.profileId]),
    );
    expect(
      (await (await request("/api/upload-defaults")).json()).defaultProfileId,
    ).toBe(other.id);
    expect(
      (
        await request("/api/auth/upload-default", "PUT", {
          profileId: other.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/uploads", "POST", { size: 10, profileId: other.id }))
        .status,
    ).toBe(403);
    expect((await request("/api/uploads", "POST", { size: 10 })).status).toBe(
      403,
    );
    await f.app.db.transaction((r) => r.replaceUserProfiles(member.id, []));
    expect(
      (await (await request("/api/uploads", "POST", { size: 10 })).json()).error
        .code,
    ).toBe("FORBIDDEN");
  } finally {
    await f.close();
  }
});

test("invalid credentials never fall back to guest defaults and preference changes require CSRF", async () => {
  const f = await fixture();
  try {
    const p = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      { ...p, allowGuestUpload: true, expectedVersion: p.configVersion },
      p.id,
    );
    const handle = handler(f.app);
    expect(
      (
        await (
          await handle(new Request("http://localhost/api/upload-defaults"))
        ).json()
      ).defaultProfileId,
    ).toBe(f.profileId);
    for (const headers of [
      { authorization: "Bearer invalid" },
      { cookie: "session=invalid" },
    ] as Record<string, string>[]) {
      expect(
        (
          await handle(
            new Request("http://localhost/api/upload-defaults", { headers }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await handle(
            new Request("http://localhost/api/uploads", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ size: 10 }),
            }),
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await handle(
          new Request("http://localhost/api/auth/upload-default", {
            method: "PUT",
            headers: { cookie: f.cookie, "content-type": "application/json" },
            body: JSON.stringify({ profileId: f.profileId }),
          }),
        )
      ).status,
    ).toBe(403);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "token" })
    ).json();
    expect(
      (
        await f.request(
          "/api/auth/upload-default",
          "PUT",
          { profileId: f.profileId },
          token.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          "/api/site-upload-default",
          "PUT",
          { profileId: f.profileId },
          token.token,
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
