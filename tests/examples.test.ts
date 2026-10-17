import { test, expect } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";
import { zip } from "./package-fixtures";
import datePath from "../examples/path";

test("path example uses upload time and the current key result contract", async () => {
  const runtime = await datePath.createInstance();
  expect(
    await runtime.generate({
      fileId: "sample",
      uploadedAt: Date.UTC(2026, 0, 2),
      metadata: {
        mimeType: "image/svg+xml",
        byteSize: 1,
        width: null,
        height: null,
      },
    }),
  ).toEqual({ logicalKey: "2026/01/02/sample.svg" });
});

test("three example packages install and upload, resize, read, restart and delete", async () => {
  const f = await fixture();
  try {
    for (const name of ["path", "storage", "processor"]) {
      const build = await Bun.build({
        entrypoints: [`examples/${name}/index.ts`],
        target: "bun",
        format: "esm",
      });
      expect(build.success).toBe(true);
      const form = new FormData();
      form.set(
        "file",
        new File(
          [
            zip({
              "plugin.json": await Bun.file(
                `examples/${name}/plugin.json`,
              ).text(),
              "index.js": await build.outputs[0]!.text(),
            }),
          ],
          `${name}.zip`,
        ),
      );
      const inspected = await f.request("/api/plugins/inspect", "POST", form);
      expect(inspected.status).toBe(200);
      const installed = await f.request("/api/plugins/install", "POST", {
        ticket: (await inspected.json()).ticket,
        confirmTrusted: true,
      });
      expect(installed.status).toBe(201);
    }
    const storage = await f.app.plugins.save({
      pluginId: "example.local-storage",
      version: "1.0.0",
      name: "Example",
      config: { root: join(f.root, "example-storage") },
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.db.transaction((r) =>
      r.replaceMembers(profile.storageGroupId, [
        { instanceId: storage.id, weight: 1 },
      ]),
    );
    const pipeline = await f.app.configuration.savePipeline({
      name: "Example resize",
      kind: "upload",
      steps: [
        {
          pluginId: "example.resize",
          version: "1.0.0",
          config: { width: 8 },
          enabledParams: [],
          onNotApplicable: "abort",
        },
      ],
    });
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        path: { pluginId: "example.date-path", version: "1.0.0", config: {} },
        uploadPipelineId: pipeline.id,
      },
      profile.id,
    );
    const uploaded = await f.upload();
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json();
    const row = (await f.app.db.read((r) => r.file(file.id)))!;
    expect(row.logical_key).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[^/]+\.png$/);
    const path = new URL(file.url).pathname;
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(
      (await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width,
    ).toBe(8);
    const disk = Bun.file(join(f.root, "example-storage", row.storage_key));
    expect(await disk.exists()).toBe(true);
    await f.restart();
    const reopened = await f.request(path);
    expect(reopened.status).toBe(200);
    await reopened.arrayBuffer();
    expect((await f.request(`/api/files/${file.id}`, "DELETE")).status).toBe(
      202,
    );
    await f.app.files.sweep();
    expect(await Bun.file(disk.name!).exists()).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);
