import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";
import datePath from "../examples/path/src";

async function installExamples(
  f: Awaited<ReturnType<typeof fixture>>,
  names: string[],
) {
  for (const name of names) {
    const directory = resolve(import.meta.dir, "../examples", name);
    const build = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../node_modules/@picloom/plugin-tools/dist/cli.js"),
        "build",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    if (code) throw Error(out + err);
    const manifest = await Bun.file(join(directory, "plugin.json")).json();
    const bytes = await Bun.file(
      join(directory, "dist", `${manifest.id}-${manifest.version}.zip`),
    ).bytes();
    const form = new FormData();
    form.set("file", new File([bytes], `${name}.zip`));
    const inspected = await f.request("/api/plugins/inspect", "POST", form);
    expect(inspected.status).toBe(200);
    const installed = await f.request("/api/plugins/install", "POST", {
      ticket: (await inspected.json()).ticket,
      confirmTrusted: true,
    });
    expect(installed.status).toBe(201);
  }
}

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
    await installExamples(f, ["path", "storage", "processor"]);
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
    // A request value only overrides fixed configuration after the step enables it.
    for (const enabled of [false, true]) {
      if (enabled)
        await f.app.configuration.savePipeline(
          {
            ...pipeline,
            expectedVersion: pipeline.configVersion,
            steps: [{ ...pipeline.steps[0]!, enabledParams: ["width"] }],
          },
          pipeline.id,
        );
      const form = new FormData();
      form.set("profileId", f.profileId);
      form.set("file", new File([new Uint8Array(f.png)], "image.png"));
      form.set("params", JSON.stringify({ width: 4 }));
      const response = await f.request("/api/files", "POST", form);
      expect(response.status).toBe(201);
      const value = await response.json();
      const image = await f.request(new URL(value.url).pathname);
      expect(image.status).toBe(200);
      expect(
        (await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width,
      ).toBe(enabled ? 4 : 8);
    }
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

test("access and post-save example packages preserve originals and apply review results", async () => {
  const f = await fixture();
  try {
    await installExamples(f, ["access", "post-save"]);
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            pluginId: "example.thumbnail",
            version: "1.0.0",
            config: {},
            enabledParams: ["width"],
            onNotApplicable: "abort",
          },
        ],
      },
      access.id,
    );
    const response = await f.upload();
    expect(response.status).toBe(201);
    const image = await response.json();
    const path = new URL(image.url).pathname;
    for (const [query, width] of [
      ["", 40],
      ["?width=16", 16],
      ["?width=16", 16],
      ["", 40],
    ] as const) {
      const result = await f.request(path + query);
      expect(result.status).toBe(200);
      expect(
        (await sharp(Buffer.from(await result.arrayBuffer())).metadata()).width,
      ).toBe(width);
    }
    const chain = await f.app.configuration.savePipeline({
      name: "Example review",
      kind: "post_save",
      steps: [
        {
          pluginId: "example.width-review",
          version: "1.0.0",
          config: { maxWidth: 20 },
        },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        postSavePipelineId: chain.id,
      },
      profile.id,
    );
    for (const width of [10, 40]) {
      const png = await sharp(f.png).resize({ width }).png().toBuffer();
      const upload = await f.upload(undefined, png);
      expect(upload.status).toBe(201);
      const result = await upload.json();
      await f.app.files.sweep();
      await f.app.files.tasks.drain();
      const file = (await f.app.db.read((r) => r.file(result.id)))!;
      expect(file.status).toBe(width > 20 ? "blocked" : "ready");
      expect(file.processing_results_json?.[0]).toMatchObject({
        status: width > 20 ? "block" : "pass",
        details: { width, maxWidth: 20 },
      });
      const read = await f.request(new URL(result.url).pathname);
      expect(read.status).toBe(width > 20 ? 404 : 200);
      await read.arrayBuffer();
    }
  } finally {
    await f.close();
  }
}, 20000);
