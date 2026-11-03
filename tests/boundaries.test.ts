import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { entity } from "../src/persistence/port";
import type { Definition } from "../src/plugins/api";
import { prefix, scopedInput } from "../src/infra/files";
test("path collision protects managed images and deletion releases the path", async () => {
  const f = await fixture();
  try {
    const def: Definition<"path"> = {
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: {
        "en-US": {
          "package.name": "fixed",
        },
      },

      id: "test.fixed",

      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      kind: "path",
      configSchema: { type: "object" },
      async createInstance() {
        return {
          async generate() {
            return { logicalKey: "fixed.png" };
          },
        };
      },
    };
    f.app.plugins.register(def);
    const inst = await f.app.plugins.save({
      pluginId: def.id,
      version: "1",
      name: "fixed",
      config: {},
    });
    const original = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    const p = {
      ...original,
      ...entity(),
      is_default: false,
      public_prefix: "/fixed/",
      path_instance_id: inst.id,
    };
    await f.app.db.transaction((r) => r.insertProfile(p));
    const upload = async () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(f.png)], "x.png"));
      form.set("profileId", p.id);
      return f.request("/api/files", "POST", form);
    };
    const first = await upload();
    expect(first.status).toBe(201);
    const v = await first.json();
    expect((await upload()).status).toBe(409);
    expect(
      new Uint8Array(await (await f.request("/fixed/fixed.png")).arrayBuffer()),
    ).toEqual(new Uint8Array(f.png));
    await f.app.files.delete(v.id);
    await f.app.files.sweep();
    expect((await upload()).status).toBe(201);
    expect(await f.app.db.read((r) => r.files(10, 0))).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("reserved prefixes, expiration and file size policy are enforced", async () => {
  expect(() => prefix("/api/")).toThrow();
  expect(prefix("/i/sub/")).toBe("/i/sub/");
  const f = await fixture();
  try {
    const expired = {
      ...entity(),
      user_id: (await f.app.db.read((r) => r.userByName("admin")))!.id,
      token_hash: (await import("../src/core/auth")).hash("expired"),
      expires_at: 0,
      revoked_at: null,
      name: "expired",
      token_hint: "expired",
    };
    await f.app.db.transaction((r) => r.insertCredential("token", expired));
    expect((await f.upload("expired")).status).toBe(401);
    const original = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    const small = {
      ...original,
      ...entity(),
      is_default: false,
      name: "small",
      path_instance_id: (
        await f.app.plugins.save({
          pluginId: "builtin.date-path",
          version: "1.0.0",
          name: "Small path",
          config: {},
        })
      ).id,
      max_upload_bytes: 1,
    };
    await f.app.db.transaction((r) => r.insertProfile(small));
    const form = new FormData();
    form.set("profileId", small.id);
    form.set("file", new File([new Uint8Array(f.png)], "x.png"));
    expect((await f.request("/api/files", "POST", form)).status).toBe(413);
  } finally {
    await f.close();
  }
});
test("scope cleanup cancels plugin-owned locked readers", async () => {
  let cancelled = false;
  const scope = scopedInput(
    {
      metadata: { mimeType: null, byteSize: null, width: null, height: null },
      async openRead() {
        return new ReadableStream({
          cancel() {
            cancelled = true;
          },
        });
      },
    },
    new AbortController().signal,
  );
  const stream = await scope.file.openRead();
  const reader = stream.getReader();
  await scope.close();
  expect(cancelled).toBe(true);
  await expect(reader.read()).rejects.toThrow();
  reader.releaseLock();
});
test("Database drivers and SQL stay in persistence layer", async () => {
  const paths = new Bun.Glob("src/**/*.ts");
  for await (const path of paths.scan({ cwd: process.cwd() })) {
    if (path.replaceAll("\\", "/").startsWith("src/persistence/")) continue;
    const source = await Bun.file(path).text();
    expect(source).not.toMatch(
      /from ["'](?:pg|kysely)["']|bun:sqlite|SQLITE_CONSTRAINT|SELECT\s+\*\s+FROM|INSERT\s+INTO/,
    );
  }
});
