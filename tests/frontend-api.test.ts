import { test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { entity } from "../src/persistence/port";
import { prefix } from "../src/infra/files";

test("frontend endpoints expose public safe limits and protected profile options", async () => {
  const f = await fixture();
  try {
    const p = (await (await f.request("/api/upload-profiles")).json())[0];
    expect(p.available).toBe(true);
    expect(p.maxUploadBytes).toBe(f.app.config.maxUploadBytes);
    expect(Object.keys(p).sort()).toEqual(
      [
        "id",
        "name",
        "publicPrefix",
        "maxUploadBytes",
        "allowedMimeTypes",
        "available",
        "enabled",
        "reason",
        "reasonCode",
      ].sort(),
    );
    const settings = await (await f.request("/api/client-settings")).json();
    expect(settings).toEqual({
      enabledLocales: ["zh-CN", "en-US"],
      defaultLocale: "en-US",
      content: {},
      siteLogoUrl: "",
      siteFaviconUrl: "",
      uploadConcurrency: 4,
      chunkedUpload: {
        thresholdBytes: 8 * 1024 ** 2,
        partBytes: 4 * 1024 ** 2,
        concurrency: 2,
      },
      maxUploadBytes: f.app.config.maxUploadBytes,
      maxDimension: f.app.config.maxDimension,
      maxPixels: f.app.config.maxPixels,
    });
    expect(
      (
        await f.request(
          "/api/client-settings",
          "GET",
          undefined,
          "invalid-token",
        )
      ).status,
    ).toBe(200);
    const token = await (
      await f.request("/api/tokens", "POST", {
        name: "test",
        profileIds: [f.profileId],
      })
    ).json();
    const scopedProfiles = await f.request(
      "/api/upload-profiles",
      "GET",
      undefined,
      token.token,
    );
    expect(scopedProfiles.status).toBe(200);
    expect(await scopedProfiles.json()).toEqual([p]);
    expect(
      (await f.request("/api/files", "GET", undefined, token.token)).status,
    ).toBe(403);
    const original = await f.app.db.read((r) => r.profile(f.profileId));
    const disabledPath = await f.app.plugins.save({
      pluginId: "builtin.date-path",
      version: "1.0.0",
      name: "Disabled path",
      config: {},
    });
    const unsupportedPath = await f.app.plugins.save({
      pluginId: "builtin.date-path",
      version: "1.0.0",
      name: "Unsupported path",
      config: {},
    });
    await f.app.db.transaction((r) =>
      r.insertProfile({
        ...original!,
        ...entity(),
        is_default: false,
        name: "Disabled",
        path_instance_id: disabledPath.id,
        enabled: false,
      }),
    );
    const profiles = await (await f.request("/api/upload-profiles")).json();
    const scopedAfterCreation = await f.request(
      "/api/upload-profiles",
      "GET",
      undefined,
      token.token,
    );
    expect(scopedAfterCreation.status).toBe(200);
    expect(
      (await scopedAfterCreation.json()).map(
        (profile: { id: string }) => profile.id,
      ),
    ).toEqual([f.profileId]);
    expect(profiles.find((p: any) => p.name === "Disabled").available).toBe(
      false,
    );
    expect(profiles.find((p: any) => p.name === "Disabled").reasonCode).toBe(
      "DISABLED",
    );
    const group = (await f.app.db.read((r) =>
      r.group(original!.storage_group_id),
    ))!;
    const unsupportedGroup = { ...group, ...entity(), redundancy_count: 1 };
    await f.app.db.transaction(async (r) => {
      await r.insertGroup(unsupportedGroup);
      await r.insertProfile({
        ...original!,
        ...entity(),
        is_default: false,
        name: "Unsupported group",
        path_instance_id: unsupportedPath.id,
        storage_group_id: unsupportedGroup.id,
      });
    });
    const unsupported = await (await f.request("/api/upload-profiles")).json();
    expect(
      unsupported.find((p: any) => p.name === "Unsupported group").reason,
    ).toContain("冗余数");
    f.app.plugins.register({
      defaultLocale: "en-US",
      content: { "en-US": { name: "failed" } },

      id: "test.failed-path",

      kind: "path",
      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      configSchema: { type: "object", properties: {} },
      async createInstance() {
        throw new Error("secret initialization diagnostic");
      },
    });
    const broken = await f.app.plugins.save({
      pluginId: "test.failed-path",
      version: "1",
      name: "failed path",
      config: {},
    });
    await f.app.db.transaction((r) =>
      r.insertProfile({
        ...original!,
        ...entity(),
        is_default: false,
        name: "Broken",
        path_instance_id: broken.id,
      }),
    );
    const failed = await (await f.request("/api/upload-profiles")).json();
    expect(failed.find((p: any) => p.name === "Broken").available).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("secret initialization");
    const instance = await f.app.db.read((r) =>
      r.instance(original!.path_instance_id),
    );
    await f.app.plugins.close();
    const unavailable = await (await f.request("/api/upload-profiles")).json();
    expect(unavailable[0].available).toBe(false);
    expect(JSON.stringify(unavailable)).not.toContain(
      instance!.config_json.root ?? "unlikely-path-marker",
    );
  } finally {
    await f.close();
  }
});

test("files remain arrays with count, literal filters, encoded URLs and password errors preserve sessions", async () => {
  const f = await fixture();
  try {
    const a = await (await f.upload()).json();
    const b = await (await f.upload()).json();
    const original = (await f.app.db.read((r) => r.file(a.id)))!;
    await f.app.db.transaction((r) =>
      r.insertFile({
        ...original,
        ...entity(),
        logical_key: "space/中文 % image.png",
        storage_key: "space/中文 % image.png",
        status: "failed",
      }),
    );
    const list = await f.request(
      "/api/files?limit=1&status=ready&mimeType=image%2Fpng",
    );
    expect(list.headers.get("X-Total-Count")).toBe("2");
    expect(Array.isArray(await list.json())).toBe(true);
    const search = await f.request("/api/files?q=" + encodeURIComponent("%"));
    expect(search.headers.get("X-Total-Count")).toBe("1");
    const [match] = await search.json();
    expect(match.url).toBe(
      "http://localhost/i/space/%E4%B8%AD%E6%96%87%20%25%20image.png",
    );
    expect((await (await f.request("/api/files/" + b.id)).json()).url).toBe(
      b.url,
    );
    expect((await f.request("/api/files?status=unknown")).status).toBe(400);
    expect((await f.request("/api/files?mimeType=bad")).status).toBe(400);
    expect((await f.request("/api/files?offset=-1")).status).toBe(400);
    const password = await f.request("/api/auth/password", "POST", {
      oldPassword: "wrong",
      password: "new-password-123",
    });
    expect(password.status).toBe(400);
    expect((await password.json()).error.code).toBe("INCORRECT_PASSWORD");
    expect((await f.request("/api/auth/session")).status).toBe(200);
  } finally {
    await f.close();
  }
});

test("web assets, public home and workspace fallback are bounded to UI routes", async () => {
  const f = await fixture();
  try {
    f.app.config.webRoot = join(f.root, "web");
    expect((await f.request("/app/images")).status).toBe(503);
    await mkdir(join(f.app.config.webRoot, "assets"), { recursive: true });
    await writeFile(
      join(f.app.config.webRoot, "index.html"),
      "<html>test admin</html>",
    );
    await writeFile(
      join(f.app.config.webRoot, "assets", "main-a1b2.js"),
      "console.log(1)",
    );
    for (const path of [
      "/",
      "/login",
      "/app/images",
      "/app/tokens",
      "/app/account",
      "/app/plugins",
      "/app/settings",
      "/app/system",
      "/app/users",
      "/app/config/pipelines",
    ]) {
      expect((await f.request(path)).status).toBe(200);
      const headPage = await f.request(path, "HEAD");
      expect(headPage.status).toBe(200);
      expect(await headPage.text()).toBe("");
    }
    const page = await f.request("/app/images");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain("test admin");
    expect((await f.request("/app")).status).toBe(308);
    const head = await f.request("/assets/main-a1b2.js", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toContain("immutable");
    for (const path of [
      "/assets/missing.js",
      "/app/unknown",
      "/assets/..%2f..%2fsecret",
      "/missing-image",
      "/admin/login",
      "/admin/files",
      "/login/unknown",
    ])
      expect((await f.request(path)).status).toBe(404);
    const invalidPath = await f.request("/admin/");
    expect(invalidPath.status).toBe(400);
    expect((await invalidPath.json()).error.code).toBe("INVALID_INPUT");
    expect((await f.request("/api/unknown")).status).toBe(404);
    expect(() => prefix("/app/")).toThrow();
    expect(() => prefix("/assets/")).toThrow();
    expect(() => prefix("/login/")).toThrow();
    expect(() => prefix("/app/config/")).toThrow();
    expect(prefix("/application/")).toBe("/application/");
    expect((await f.request("/app")).headers.get("location")).toBe(
      "/app/images",
    );
  } finally {
    await f.close();
  }
});

test("reserved prefixes disable UI without rewriting old image links, including tombstones", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    const original = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    await f.app.db.transaction((r) =>
      r.insertFile({
        ...original,
        ...entity(),
        public_prefix: "/app/",
        logical_key: "old.png",
        storage_key: "old.png",
        status: "deleted",
        deleted_at: Date.now(),
      }),
    );
    await f.restart();
    expect(f.app.webConflict).toBe(true);
    expect((await f.request("/app/images")).status).toBe(404);
    const image = await f.request(new URL(uploaded.url).pathname);
    expect(image.status).toBe(200);
    await image.arrayBuffer();
  } finally {
    await f.close();
  }
});

test("deletion failure is visible in operations without leaking storage errors", async () => {
  const f = await fixture({
    beforeDelete: async () => {
      throw new Error("secret root");
    },
  });
  try {
    const uploaded = await (await f.upload()).json();
    await f.request("/api/files/" + uploaded.id, "DELETE");
    await f.app.files.sweep();
    const detail = await (await f.request("/api/files/" + uploaded.id)).json();
    expect(detail.status).toBe("deleting");
    expect(detail.error).toBeNull();
    const response = await f.request(`/api/files/${uploaded.id}/operations`);
    expect(response.status).toBe(200);
    const operations = await response.json();
    expect(operations.tasks).toContainEqual(
      expect.objectContaining({ kind: "delete", error: "DELETE_FAILED" }),
    );
    expect(JSON.stringify(operations)).not.toContain("secret root");
    expect(JSON.stringify(detail)).not.toContain("secret root");
  } finally {
    await f.close();
  }
});
