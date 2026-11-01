import { expect, test } from "bun:test";
import sharp from "sharp";
import { sharpProcessor } from "../src/builtins/processor/sharp";
import { watermark } from "../src/builtins/processor/watermark";
import { fixture } from "./helpers";
import { taskFailure } from "../src/core/errors";
import type {
  Config,
  InstanceServices,
  Output,
  PostSaveContext,
  PostSaveProcessInput,
} from "@picloom/plugin-sdk";

const context = {
  signal: new AbortController().signal,
} as PostSaveContext;
const services = { images: { sharp } } as InstanceServices;
const watermarkConfig = {
  type: "text",
  text: "A",
  font: "sans",
  sizeMode: "fixed",
  fontSize: 12,
  margin: 0,
  position: "center",
  opacity: 100,
  color: "#ffffff",
};

async function input(mimeType = "image/png") {
  const png = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
  let bytes = png;
  let reads = 0;
  const file = {
    metadata: { mimeType, byteSize: png.length, width: 40, height: 30 },
    async openRead() {
      reads++;
      return new Blob([new Uint8Array(png)]).stream();
    },
  };
  const value: PostSaveProcessInput = {
    operationId: "post-save:test",
    record: {
      id: "file",
      createdAt: 1,
      origin: { kind: "upload", userId: null },
      ownerId: null,
      organization: { tags: [], collections: [] },
    },
    publicPath: "/i/file.png",
    url: "/i/file.png",
    currentDisposition: "pass",
    previousResults: [],
    limits: { maxDimension: 1000, maxPixels: 1_000_000 },
    file,
    async createOutput(): Promise<Output> {
      return {
        ...file,
        handle: "output",
        async write(stream) {
          bytes = Buffer.from(await new Response(stream).arrayBuffer());
        },
      };
    },
  };
  return { value, bytes: () => bytes, reads: () => reads };
}

for (const [definition, config, noop] of [
  [sharpProcessor, { w: 20 }, {}],
  [watermark, watermarkConfig, { type: "text", text: "" }],
] as const) {
  test(`${definition.id} processes fixed post-save configuration and rejects unsupported content`, async () => {
    const stage = definition.stages.post_save!;
    expect(stage).not.toHaveProperty("paramsSchema");
    const runtime = await stage.createInstance({
      id: "test",
      config,
      services,
    });
    const source = await input();
    const result = await runtime.process(source.value, context);
    expect(result.status).toBe("replace");
    expect(source.reads()).toBe(1);
    const output = await sharp(source.bytes()).metadata();
    expect(output.width).toBe(definition.id === "builtin.sharp" ? 20 : 40);
    const unsupported = await input("image/svg+xml");
    await expect(
      runtime.process(unsupported.value, context),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(unsupported.reads()).toBe(0);
    const disabled = await stage.createInstance({
      id: "disabled",
      config: noop as Config,
      services,
    });
    expect(await disabled.process(unsupported.value, context)).toEqual({
      status: "pass",
    });
    expect(unsupported.reads()).toBe(0);
  });
}

for (const [pluginId, config, animated] of [
  ["builtin.sharp", { format: "jpeg" }, false],
  ["builtin.sharp", { w: 2 }, true],
  ["builtin.watermark", watermarkConfig, true],
] as const) {
  test(`${pluginId} preserves ${animated ? "animated WebP" : "transparent PNG"} when post-save processing is unsupported`, async () => {
    const f = await fixture({
      afterWrite: async () => {
        await f.app.files.tasks.pause();
      },
    });
    try {
      const bytes = animated
        ? await sharp(
            Buffer.from([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0]),
            { raw: { width: 1, height: 4, channels: 3, pageHeight: 2 } },
          )
            .webp({ loop: 0, delay: [100, 100] })
            .toBuffer()
        : f.png;
      const chain = await f.app.configuration.savePipeline({
        name: "Preserve unsupported content",
        kind: "post_save",
        steps: [{ pluginId, version: "1.0.0", config }],
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
      const upload = await f.upload(
        undefined,
        bytes,
        animated ? "animated.webp" : "transparent.png",
      );
      expect(upload.status).toBe(201);
      const saved = await upload.json();
      const original = (await f.app.db.read((r) => r.file(saved.id)))!;
      f.app.files.tasks.resume();
      await f.app.files.sweep();

      const current = (await f.app.db.read((r) => r.file(saved.id)))!;
      const action = (await f.app.db.read((r) => r.tasks(saved.id))).find(
        (task) => task.kind === "action",
      )!;
      expect(action.status).toBe("failed");
      expect(taskFailure(action.last_error).code).toBe("PLUGIN_UNSUPPORTED");
      expect(current.status).toBe("ready");
      expect(current.id).toBe(original.id);
      const response = await f.request(new URL(saved.url).pathname);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(
        true,
      );
    } finally {
      await f.close();
    }
  });
}
