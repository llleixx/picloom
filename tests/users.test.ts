import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";

async function member(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  profiles = [f.profileId],
) {
  const created = await f.request("/api/users", "POST", {
    username: name,
    password: "member-password-123",
    role: "member",
    profileIds: profiles,
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();
  const login = await handler(f.app)(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: name, password: "member-password-123" }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const session = await handler(f.app)(
    new Request("http://localhost/api/auth/session", { headers: { cookie } }),
  );
  const info = await session.json();
  expect(info.user.role).toBe("member");
  const request = (path: string, method = "GET", data?: unknown) =>
    handler(f.app)(
      new Request("http://localhost" + path, {
        method,
        headers: { cookie, "x-csrf-token": info.csrfToken },
        body:
          data instanceof FormData
            ? data
            : data === undefined
              ? undefined
              : JSON.stringify(data),
      }),
    );
  return { id, request, cookie };
}
function form(f: Awaited<ReturnType<typeof fixture>>) {
  const data = new FormData();
  data.set("profileId", f.profileId);
  data.set("file", new File([new Uint8Array(f.png)], "image.png"));
  return data;
}
async function guestProfile(
  f: Awaited<ReturnType<typeof fixture>>,
  allowed: boolean,
) {
  const profile = await f.app.configuration.profileEditor(f.profileId);
  await f.app.configuration.saveProfileEditor(
    {
      ...profile,
      allowGuestUpload: allowed,
      expectedVersion: profile.configVersion,
    },
    profile.id,
  );
}
function transport(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  key: string,
  suffix = "",
  method = "GET",
  body?: Uint8Array,
) {
  return handler(f.app)(
    new Request(`http://localhost/api/uploads/${id}${suffix}`, {
      method,
      headers: { "x-upload-key": key },
      body: body as BodyInit | undefined,
    }),
  );
}

test("member ownership scopes list/count/detail/thumbnail/batch deletion and configuration", async () => {
  const f = await fixture();
  try {
    const a = await member(f, "alice"),
      b = await member(f, "bob", []);
    expect(await (await b.request("/api/upload-profiles")).json()).toEqual([]);
    expect((await b.request("/api/files", "POST", form(f))).status).toBe(403);
    const uploaded = await (
      await a.request("/api/files", "POST", form(f))
    ).json();
    const list = await a.request("/api/files");
    expect(list.headers.get("x-total-count")).toBe("1");
    expect((await list.json())[0].ownerId).toBe(a.id);
    const other = await b.request("/api/files?owner=" + a.id);
    expect(other.headers.get("x-total-count")).toBe("0");
    for (const suffix of ["", "/thumbnail"])
      expect(
        (await b.request(`/api/files/${uploaded.id}${suffix}`)).status,
      ).toBe(404);
    expect(
      (await b.request(`/api/files/${uploaded.id}`, "DELETE")).status,
    ).toBe(404);
    expect(
      (
        await (
          await b.request("/api/files/batch-delete", "POST", {
            ids: [uploaded.id],
          })
        ).json()
      ).results[0],
    ).toMatchObject({ accepted: false, error: "NOT_FOUND" });
    for (const path of [
      "/api/users",
      "/api/settings",
      "/api/system/status",
      "/api/plugins",
      "/api/storage-groups",
      `/api/files/${uploaded.id}/operations`,
    ])
      expect((await a.request(path)).status).toBe(403);
    expect(
      (await a.request("/api/users", "POST", { username: "evil" })).status,
    ).toBe(403);
    const original = await handler(f.app)(new Request(uploaded.url));
    expect(original.status).toBe(200);
    await original.arrayBuffer();
    expect(
      (await a.request(`/api/files/${uploaded.id}/thumbnail`)).status,
    ).toBe(200);
    expect(
      (await f.request("/api/files?owner=" + a.id)).headers.get(
        "x-total-count",
      ),
    ).toBe("1");
    expect(
      (await a.request(`/api/files/${uploaded.id}`, "DELETE")).status,
    ).toBe(202);
  } finally {
    await f.close();
  }
});

test("guest configuration, null ownership and invalid credentials never downgrade", async () => {
  const f = await fixture();
  try {
    const guest = (
      path: string,
      method = "GET",
      body?: BodyInit,
      headers?: HeadersInit,
    ) =>
      handler(f.app)(
        new Request("http://localhost" + path, { method, body, headers }),
        "203.0.113.9",
      );
    expect(await (await guest("/api/upload-profiles")).json()).toEqual([]);
    expect((await guest("/api/client-settings")).status).toBe(200);
    expect((await guest("/api/files", "POST", form(f))).status).toBe(403);
    await guestProfile(f, true);
    const uploaded = await (await guest("/api/files", "POST", form(f))).json();
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))!.owner_id,
    ).toBeNull();
    expect(
      (await f.request("/api/files?owner=guest")).headers.get("x-total-count"),
    ).toBe("1");
    for (const path of [
      "/api/files",
      `/api/files/${uploaded.id}`,
      `/api/files/${uploaded.id}/thumbnail`,
      "/api/tokens",
    ])
      expect((await guest(path)).status).toBe(401);
    expect(
      (
        await guest("/api/files", "POST", form(f), {
          authorization: "Bearer invalid",
        })
      ).status,
    ).toBe(401);
    const b = await member(f, "bob", []);
    expect(
      (await (await b.request("/api/upload-profiles")).json()).length,
    ).toBe(1);
    // More than the former per-minute limit can start sessions from the same IP.
    for (let i = 0; i < 11; i++) {
      const response = await guest(
        "/api/uploads",
        "POST",
        JSON.stringify({ profileId: f.profileId, size: f.png.length }),
      );
      expect(response.status).toBe(201);
    }
  } finally {
    await f.close();
  }
});

test("upload keys survive logout and restart, isolate sessions and recheck guest or user grants", async () => {
  const f = await fixture();
  try {
    const a = await member(f, "alice");
    const upload = await (
      await a.request("/api/uploads", "POST", {
        profileId: f.profileId,
        size: f.png.length,
      })
    ).json();
    expect(upload.uploadKey.length).toBeGreaterThan(30);
    expect(
      (await f.app.db.read((r) => r.uploadSession(upload.id)))!.upload_key_hash,
    ).not.toBe(upload.uploadKey);
    expect((await transport(f, upload.id, "wrong")).status).toBe(404);
    expect(
      (
        await handler(f.app)(
          new Request(`http://localhost/api/uploads/${upload.id}`, {
            headers: { cookie: a.cookie },
          }),
        )
      ).status,
    ).toBe(404);
    await a.request("/api/auth/logout", "POST");
    expect(
      (
        await transport(
          f,
          upload.id,
          upload.uploadKey,
          "/parts/0",
          "PUT",
          new Uint8Array(f.png),
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await transport(f, upload.id, upload.uploadKey)).json()).parts,
    ).toEqual([0]);
    await f.restart();
    const complete = await transport(
      f,
      upload.id,
      upload.uploadKey,
      "/complete",
      "POST",
    );
    expect(complete.status).toBe(200);
    const result = await complete.json();
    expect((await f.app.db.read((r) => r.file(result.id)))!.owner_id).toBe(
      a.id,
    );
    expect(
      await (
        await transport(f, upload.id, upload.uploadKey, "/complete", "POST")
      ).json(),
    ).toEqual(result);
    await guestProfile(f, true);
    const guest = await (
      await handler(f.app)(
        new Request("http://localhost/api/uploads", {
          method: "POST",
          body: JSON.stringify({ profileId: f.profileId, size: f.png.length }),
        }),
      )
    ).json();
    expect((await transport(f, guest.id, upload.uploadKey)).status).toBe(404);
    await transport(
      f,
      guest.id,
      guest.uploadKey,
      "/parts/0",
      "PUT",
      new Uint8Array(f.png),
    );
    await guestProfile(f, false);
    expect(
      (await transport(f, guest.id, guest.uploadKey, "/complete", "POST"))
        .status,
    ).toBe(403);
    expect(
      (await transport(f, guest.id, guest.uploadKey, "", "DELETE")).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test("tokens intersect grants; account disable revokes credentials; password reset keeps tokens; last admin is protected", async () => {
  const f = await fixture();
  try {
    const a = await member(f, "alice");
    const token = await (
      await a.request("/api/tokens", "POST", {
        name: "upload",
        profileIds: [f.profileId],
        expiresAt: null,
      })
    ).json();
    const chunk = await (
      await a.request("/api/uploads", "POST", {
        profileId: f.profileId,
        size: f.png.length,
      })
    ).json();
    await transport(
      f,
      chunk.id,
      chunk.uploadKey,
      "/parts/0",
      "PUT",
      new Uint8Array(f.png),
    );
    await f.request(`/api/users/${a.id}`, "PUT", {
      role: "member",
      status: "active",
      profileIds: [],
    });
    expect((await f.upload(token.token)).status).toBe(403);
    expect(
      (await transport(f, chunk.id, chunk.uploadKey, "/complete", "POST"))
        .status,
    ).toBe(403);
    await f.request(`/api/users/${a.id}`, "PUT", {
      role: "member",
      status: "active",
      profileIds: [f.profileId],
    });
    expect(
      (
        await f.request(`/api/users/${a.id}/password`, "POST", {
          password: "changed-password-123",
        })
      ).status,
    ).toBe(200);
    expect((await a.request("/api/auth/session")).status).toBe(401);
    expect((await f.upload(token.token)).status).toBe(201);
    await f.request(`/api/users/${a.id}`, "PUT", {
      role: "member",
      status: "disabled",
      profileIds: [],
    });
    await f.request(`/api/users/${a.id}`, "PUT", {
      role: "member",
      status: "active",
      profileIds: [f.profileId],
    });
    expect((await f.upload(token.token)).status).toBe(401);
    const admin = await (await f.request("/api/auth/session")).json();
    for (const settings of [
      { role: "member", status: "active" },
      { role: "admin", status: "disabled" },
    ])
      expect(
        (await f.request(`/api/users/${admin.user.id}`, "PUT", settings))
          .status,
      ).toBe(403);
  } finally {
    await f.close();
  }
});

test("revocation before publication leaves no ready file", async () => {
  let revoke = async () => {};
  const f = await fixture({ beforePublish: async () => revoke() });
  try {
    const a = await member(f, "alice");
    revoke = async () => {
      await f.app.db.transaction((r) => r.replaceUserProfiles(a.id, []));
    };
    expect((await a.request("/api/files", "POST", form(f))).status).toBe(403);
    expect(await f.app.db.read((r) => r.countFiles({ status: "ready" }))).toBe(
      0,
    );
    await f.app.files.sweep();
  } finally {
    await f.close();
  }
});

test("owner appoints admins; admins manage members only", async () => {
  const f = await fixture();
  try {
    const owner = (await (await f.request("/api/auth/session")).json()).user;
    expect(owner.role).toBe("owner");
    const admin = await member(f, "manager");
    const other = await member(f, "second");
    const user = await member(f, "ordinary");
    for (const id of [admin.id, other.id])
      expect(
        (
          await f.request("/api/users/" + id, "PUT", {
            role: "admin",
            status: "active",
          })
        ).status,
      ).toBe(200);
    expect((await admin.request("/api/storage-groups")).status).toBe(200);
    for (const id of [owner.id, admin.id, other.id]) {
      expect(
        (
          await admin.request("/api/users/" + id, "PUT", {
            role: "member",
            status: "disabled",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await admin.request("/api/users/" + id + "/password", "POST", {
            password: "replacement-password",
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await admin.request("/api/users", "POST", {
          username: "new-admin",
          password: "replacement-password",
          role: "admin",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.request("/api/users", "POST", {
          username: "new-member",
          password: "replacement-password",
          role: "member",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await admin.request("/api/users/" + user.id, "PUT", {
          role: "admin",
          status: "active",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.request("/api/users/" + user.id + "/password", "POST", {
          password: "replacement-password",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.request("/api/users/" + user.id, "PUT", {
          role: "member",
          status: "disabled",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request("/api/users/" + other.id, "PUT", {
          role: "member",
          status: "active",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request("/api/users/" + owner.id + "/password", "POST", {
          password: "replacement-password",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/api/users", "POST", {
          username: "new-owner",
          password: "replacement-password",
          role: "owner",
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

test("members cannot filter by storage source or delete individual replicas", async () => {
  const f = await fixture();
  try {
    const user = await member(f, "replica-member");
    const image = await (
      await user.request("/api/files", "POST", form(f))
    ).json();
    const replica = (await f.app.db.read((r) => r.replicas(image.id)))[0]!;
    expect(
      (await user.request(`/api/files?source=${replica.storage_instance_id}`))
        .status,
    ).toBe(403);
    expect(
      (
        await user.request(
          `/api/files/${image.id}/replicas/${replica.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await user.request("/api/files/batch-delete", "POST", {
          ids: [image.id],
          sourceId: replica.storage_instance_id,
          includeLast: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await user.request(`/api/files/${image.id}`, "DELETE")).status,
    ).toBe(202);
  } finally {
    await f.close();
  }
});
