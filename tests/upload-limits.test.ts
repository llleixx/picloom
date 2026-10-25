import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { normalizeGuestIp } from "../src/http/guest-ip";
function form(f: Awaited<ReturnType<typeof fixture>>) {
  const b = new FormData();
  b.set("profileId", f.profileId);
  b.set("file", new File([new Uint8Array(f.png)], "a.png"));
  return b;
}

test("admitted concurrent uploads finish and count once; later uploads obey the daily limit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let admitted = 0;
  const f = await fixture({
    beforePublish: async () => {
      if (++admitted === 3) release();
      await gate;
    },
  });
  try {
    const user = (await (await f.request("/api/auth/session")).json()).user;
    await f.app.db.transaction((r) =>
      r.setUserUploadLimits(user.id, f.png.length - 1, 2),
    );
    expect((await f.upload()).status).toBe(413);
    await f.app.db.transaction((r) => r.setUserUploadLimits(user.id, null, 2));
    // Exercise the daily quota with all three requests admitted.
    f.app.config.uploadConcurrency = 3;
    const results = await Promise.all([f.upload(), f.upload(), f.upload()]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const image = await results.find((r) => r.status === 201)!.json();
    expect((await f.request("/api/files/" + image.id, "DELETE")).status).toBe(
      202,
    );
    await f.app.files.sweep();
    await f.restart();
    const token = await (
      await f.request("/api/tokens", "POST", {
        name: "quota",
        expiresInDays: 1,
      })
    ).json();
    expect((await f.upload(token.token)).status).toBe(429);
    expect(
      await f.app.db.read((r) =>
        r.dailyUploadCount(
          "u:" + user.id,
          new Date().toISOString().slice(0, 10),
        ),
      ),
    ).toBe(3);
  } finally {
    release();
    await f.close();
  }
});

test("guest settings, normalized IP and chunk session bind one successful file to one daily count", async () => {
  const f = await fixture();
  try {
    const profile = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    await f.app.db.transaction((r) =>
      r.saveProfile(
        {
          ...profile,
          allow_guest_upload: true,
          config_version: profile.config_version + 1,
        },
        profile.config_version,
      ),
    );
    const saved = await f.request("/api/settings", "PUT", {
      ...f.app.delivery.get(),
      guestMaxUploadBytes: f.png.length - 1,
      guestDailyUploadLimit: 1,
    });
    expect(saved.status).toBe(200);
    const guest = (
      path: string,
      method = "GET",
      body?: BodyInit,
      ip = "::ffff:203.0.113.8",
      headers: Record<string, string> = {},
    ) =>
      handler(f.app)(
        new Request("http://localhost" + path, { method, body, headers }),
        ip,
      );
    expect((await guest("/api/files", "POST", form(f))).status).toBe(413);
    await f.app.delivery.save({
      ...f.app.delivery.get(),
      guestMaxUploadBytes: null,
    });
    const created = await guest(
      "/api/uploads",
      "POST",
      JSON.stringify({ profileId: f.profileId, size: f.png.length }),
      undefined,
      { "content-type": "application/json" },
    );
    expect(created.status).toBe(201);
    const session = await created.json();
    expect(
      (await f.app.db.read((r) => r.uploadSession(session.id)))?.guest_ip,
    ).toBe("203.0.113.8");
    expect(
      (
        await guest(
          `/api/uploads/${session.id}/parts/0`,
          "PUT",
          new Uint8Array(f.png),
          "203.0.113.99",
          { "x-upload-key": session.uploadKey },
        )
      ).status,
    ).toBe(200);
    const complete = await guest(
      `/api/uploads/${session.id}/complete`,
      "POST",
      undefined,
      "203.0.113.99",
      { "x-upload-key": session.uploadKey },
    );
    expect(complete.status).toBe(200);
    const image = await complete.json();
    expect((await f.app.db.read((r) => r.file(image.id)))?.guest_ip).toBe(
      "203.0.113.8",
    );
    await f.app.db.transaction(async (r) => {
      const current = (await r.profile(f.profileId))!;
      await r.saveProfile(
        { ...current, allow_guest_upload: false },
        current.config_version,
      );
    });
    expect(
      (
        await guest(
          `/api/uploads/${session.id}/complete`,
          "POST",
          undefined,
          undefined,
          { "x-upload-key": session.uploadKey },
        )
      ).status,
    ).toBe(200);
    await f.app.db.transaction(async (r) => {
      const current = (await r.profile(f.profileId))!;
      await r.saveProfile(
        { ...current, allow_guest_upload: true },
        current.config_version,
      );
    });
    expect(
      (await guest("/api/files", "POST", form(f), "203.0.113.8")).status,
    ).toBe(429);
    expect(
      (await guest("/api/files", "POST", form(f), "203.0.113.9")).status,
    ).toBe(201);
    expect(normalizeGuestIp("2001:0db8:0:0::1")).toBe("2001:db8::1");
    const profiles = await (await guest("/api/upload-profiles")).json();
    expect(profiles[0].maxUploadBytes).toBe(f.app.config.maxUploadBytes);
  } finally {
    await f.close();
  }
});

test("publication failure consumes no daily allowance; user editor persists and validates limits", async () => {
  const f = await fixture({
    beforePublish() {
      throw new Error("publish failed");
    },
  });
  try {
    const user = (await (await f.request("/api/auth/session")).json()).user;
    await f.app.db.transaction((r) => r.setUserUploadLimits(user.id, null, 1));
    expect((await f.upload()).status).toBe(500);
    expect(
      await f.app.db.read((r) =>
        r.dailyUploadCount(
          "u:" + user.id,
          new Date().toISOString().slice(0, 10),
        ),
      ),
    ).toBe(0);
    const response = await f.request("/api/users", "POST", {
      username: "quota",
      password: "test-password-123",
      role: "member",
      maxUploadBytes: 1048576,
      dailyUploadLimit: 3,
    });
    expect(response.status).toBe(201);
    const users = await (await f.request("/api/users")).json();
    expect(users.items.find((u: any) => u.username === "quota")).toMatchObject({
      maxUploadBytes: 1048576,
      dailyUploadLimit: 3,
    });
    expect(
      (
        await f.request("/api/users", "POST", {
          username: "bad",
          password: "test-password-123",
          role: "member",
          dailyUploadLimit: -1,
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
