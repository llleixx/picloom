import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { entity } from "../src/persistence/port";
import { publicPath } from "../src/infra/files";

async function checkImage(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
) {
  const response = await f.request(path);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(f.png),
  );
}
async function source(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  return f.app.plugins.save({
    pluginId: "builtin.local",
    version: "1.0.0",
    name,
    config: { root: join(f.root, name) },
  });
}
async function scan(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  publicPrefix: string,
) {
  const response = await f.request(
    `/api/storage-sources/${id}/import`,
    "POST",
    { publicPrefix, mimeTypes: ["image/png"] },
  );
  expect(response.status).toBe(200);
  return response.json();
}

test("nested prefixes preserve old encoded links and imports reject only complete path collisions", async () => {
  const f = await fixture();
  try {
    const parent = await source(f, "parent");
    const child = await source(f, "child");
    await mkdir(join(f.root, "parent/photos"));
    const filename = "中文 空格%20.png";
    await Bun.write(join(f.root, "parent/photos", filename), f.png);
    expect((await scan(f, parent.id, "/i/")).imported).toBe(1);
    const oldPath = publicPath("/i/", "photos/" + filename);
    const profile = await f.app.configuration.profile(f.profileId);
    await f.app.configuration.saveProfile(
      {
        ...profile,
        publicPrefix: "/i/photos/",
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    await checkImage(f, oldPath);
    await Bun.write(join(f.root, "child", filename), f.png);
    await Bun.write(join(f.root, "child/new.png"), f.png);
    expect(await scan(f, child.id, "/i/photos/")).toMatchObject({
      imported: 1,
      conflicts: 1,
    });
    await checkImage(f, "/i/photos/new.png");
    await checkImage(f, oldPath);
    expect((await f.request("/i/photos/%zz.png")).status).toBe(400);
    expect((await scan(f, child.id, "/i/photos/")).skipped).toBe(1);
  } finally {
    await f.close();
  }
});

test("concurrent uploads through nested prefixes reserve one complete path without overwriting", async () => {
  const f = await fixture();
  try {
    f.app.plugins.register({
      defaultLocale: "en-US",
      content: { "en-US": { name: "Path" } },

      id: "test.path",

      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      kind: "path",
      configSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      async createInstance({ config }) {
        return {
          async generate({ fileId }) {
            return {
              logicalKey: String(config.key),
              storageKey: fileId + ".png",
            };
          },
        };
      },
    });
    const original = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    const profiles = [];
    for (const [prefix, key] of [
      ["/i/", "photos/shared.png"],
      ["/i/photos/", "shared.png"],
    ]) {
      const path = await f.app.plugins.save({
        pluginId: "test.path",
        version: "1",
        name: prefix!,
        config: { key: key! },
      });
      const profile = {
        ...original,
        ...entity(),
        is_default: false,
        public_prefix: prefix!,
        path_instance_id: path.id,
      };
      await f.app.db.transaction((r) => r.insertProfile(profile));
      profiles.push(profile);
    }
    const responses = await Promise.all(
      profiles.map((p) => {
        const form = new FormData();
        form.set("profileId", p.id);
        form.set("file", new File([new Uint8Array(f.png)], "x.png"));
        return f.request("/api/files", "POST", form);
      }),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const files = await f.app.db.read((r) => r.files(10, 0));
    expect(files).toHaveLength(1);
    expect(
      new Uint8Array(
        await (await f.request("/i/photos/shared.png")).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array(f.png));
    const legacy = await source(f, "legacy");
    await Bun.write(join(f.root, "legacy/shared.png"), f.png);
    expect((await scan(f, legacy.id, "/i/photos/")).conflicts).toBe(1);
  } finally {
    await f.close();
  }
});

test("concurrent imports through nested prefixes count a collision without partial replicas", async () => {
  const f = await fixture();
  try {
    const parent = await source(f, "race-parent");
    const child = await source(f, "race-child");
    await mkdir(join(f.root, "race-parent/photos"));
    await Bun.write(join(f.root, "race-parent/photos/shared.png"), f.png);
    await Bun.write(join(f.root, "race-child/shared.png"), f.png);
    const results = await Promise.all([
      scan(f, parent.id, "/i/"),
      scan(f, child.id, "/i/photos/"),
    ]);
    expect(results.reduce((n, r) => n + r.imported, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.conflicts, 0)).toBe(1);
    const files = await f.app.db.read((r) => r.files(10, 0));
    expect(files).toHaveLength(1);
    expect(await f.app.db.read((r) => r.replicas(files[0]!.id))).toHaveLength(
      1,
    );
    await checkImage(f, "/i/photos/shared.png");
  } finally {
    await f.close();
  }
});
