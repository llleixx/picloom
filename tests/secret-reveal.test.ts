import { test, expect } from "bun:test";
import { fixture } from "./action-fixture";
import { handler } from "../src/http/app";

test("saved plugin secrets are revealed only explicitly to authenticated administrators", async () => {
  const f = await fixture();
  try {
    const instance = await f.app.plugins.save({
      pluginId: "test.action",
      stage: "post_save",
      version: "1.0.0",
      name: "Reveal test",
      config: { url: "https://example.com/hook" },
      secretEdits: { "/token": { action: "replace", value: "saved-secret" } },
    });
    const path = `/api/plugin-configurations/${instance.id}/reveal-secret`;
    const view = await f.app.plugins.view(instance.id);
    expect(JSON.stringify(view)).not.toContain("saved-secret");
    const revealed = await f.request(path, "POST", { path: "/token" });
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(await revealed.json()).toEqual({ value: "saved-secret" });
    expect((await f.request(path, "POST", { path: "/url" })).status).toBe(400);
    const handle = handler(f.app);
    const unauthorized = await handle(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/token" }),
      }),
    );
    expect(unauthorized.status).toBe(401);
    const noCsrf = await handle(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: { cookie: f.cookie, "content-type": "application/json" },
        body: JSON.stringify({ path: "/token" }),
      }),
    );
    expect(noCsrf.status).toBe(403);
    await f.request("/api/users", "POST", {
      username: "reader",
      password: "member-password-123",
      role: "member",
      profileIds: [],
    });
    const login = await handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: "reader",
          password: "member-password-123",
        }),
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await handle(
      new Request("http://localhost/api/auth/session", { headers: { cookie } }),
    );
    const { csrfToken } = await session.json();
    const member = await handle(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrfToken },
        body: JSON.stringify({ path: "/token" }),
      }),
    );
    expect(member.status).toBe(403);
  } finally {
    await f.close();
  }
});
