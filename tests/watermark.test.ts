import { test, expect } from "bun:test";
import sharp from "sharp";
import { join } from "node:path";
import { fixture } from "./helpers";
import { watermark } from "../src/builtins/processor/watermark/index";
import { requestParameters } from "../src/core/request-params";
import type { InstanceServices } from "../src/plugins/api";

test("plugins share core Sharp and watermark works in upload and access pipelines", async () => {
  const f = await fixture();
  try {
    let received: unknown;
    f.app.plugins.register(
      {
        defaultLocale: "en-US",
        nameKey: "package.name",
        messages: {
          "en-US": {
            "package.name": "Sharp service",
          },
        },

        id: "example.sharp-service",

        kind: "path",
        version: "1",
        apiVersion: 1,
        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance({ services }) {
          received = services.images.sharp;
          return {
            async generate() {
              return { logicalKey: "test.png" };
            },
          };
        },
      },
      "external",
    );
    await f.app.plugins.save({
      pluginId: "example.sharp-service",
      version: "1",
      name: "Test",
      config: {},
    });
    expect(received).toBe(sharp);
    const logo = join(f.root, "logo.png");
    await sharp({
      create: { width: 10, height: 10, channels: 4, background: "red" },
    })
      .png()
      .toFile(logo);
    const pipeline = await f.app.configuration.savePipeline({
      name: "Watermark",
      kind: "upload",
      steps: [
        {
          pluginId: "builtin.watermark",
          version: "1.0.0",
          config: {
            font: "sans",
            fontSizePercent: 3,
            marginPercent: 2,
            fontSize: 32,
            color: "#ffffff",
            widthPercent: 10,
            type: "image",
            sizeMode: "fixed",
            imagePath: logo,
            opacity: 100,
            imageWidth: 10,
            margin: 0,
            position: "bottom-right",
          },
          enabledParams: [
            "watermarkPosition",
            "watermarkImageWidth",
            "watermarkMargin",
            "watermarkOpacity",
          ],
          onNotApplicable: "abort",
        },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        uploadPipelineId: pipeline.id,
      },
      profile.id,
    );
    const form = new FormData();
    form.set("profileId", profile.id);
    form.set(
      "file",
      new File([await Bun.file(logo).arrayBuffer()], "logo.png"),
    );
    form.set("params", JSON.stringify({ watermarkOpacity: 0 }));
    const skipped = await f.request("/api/files", "POST", form);
    expect(skipped.status).toBe(201);
    const skippedResult = await skipped.json();
    expect(
      Buffer.from(
        await (
          await f.request(new URL(skippedResult.url).pathname)
        ).arrayBuffer(),
      ),
    ).toEqual(Buffer.from(await Bun.file(logo).arrayBuffer()));
    const uploaded = await f.upload();
    expect(uploaded.status).toBe(201);
    const result = await uploaded.json();
    const originalPath = new URL(result.url).pathname;
    const bytes = await (await f.request(originalPath)).arrayBuffer();
    const pixels = await sharp(Buffer.from(bytes))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...pixels.subarray(pixels.length - 4)]).toEqual([255, 0, 0, 255]);
    expect((await sharp(Buffer.from(bytes)).metadata()).hasAlpha).toBe(true);
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            pluginId: "builtin.watermark",
            version: "1.0.0",
            config: {
              font: "sans",
              sizeMode: "relative",
              fontSizePercent: 3,
              marginPercent: 2,
              imageWidth: 128,
              widthPercent: 10,
              position: "bottom-right",
              opacity: 70,
              type: "text",
              text: "",
              fontSize: 12,
              color: "#000000",
              margin: 0,
            },
            enabledParams: ["watermarkOpacity", "watermarkText"],
            onNotApplicable: "abort",
          },
        ],
      },
      access.id,
    );
    const processed = await f.request(
      originalPath + "?watermarkText=A%26B%20%3Ctest%3E&watermarkOpacity=70",
    );
    expect(processed.status).toBe(200);
    const changed = await processed.arrayBuffer();
    expect(Buffer.from(changed).equals(Buffer.from(bytes))).toBe(false);
    const different = await f.request(
      originalPath + "?watermarkText=Different",
    );
    expect(different.status).toBe(200);
    expect(
      Buffer.from(await different.arrayBuffer()).equals(Buffer.from(changed)),
    ).toBe(false);
    const cached = await f.request(
      originalPath + "?watermarkText=A%26B%20%3Ctest%3E&watermarkOpacity=70",
    );
    expect(
      Buffer.from(await cached.arrayBuffer()).equals(Buffer.from(changed)),
    ).toBe(true);
    expect(
      Buffer.from(await (await f.request(originalPath)).arrayBuffer()).equals(
        Buffer.from(bytes),
      ),
    ).toBe(true);
    expect(
      Buffer.from(
        await (
          await f.request(originalPath + "?watermarkOpacity=0")
        ).arrayBuffer(),
      ).equals(Buffer.from(bytes)),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
test("watermark allows blank text, skips unsupported inputs and honors opacity overrides", async () => {
  expect(
    await watermark.stages.upload!.validateConfig!({ type: "text", text: " " }),
  ).toHaveLength(0);
  expect(
    await watermark.stages.upload!.validateConfig!({
      type: "image",
      imagePath: " ",
    }),
  ).toHaveLength(1);
  const runtime = await watermark.stages.access!.createInstance({
    id: "test",
    config: {
      font: "sans",
      sizeMode: "relative",
      fontSizePercent: 3,
      marginPercent: 2,
      fontSize: 32,
      color: "#ffffff",
      imageWidth: 128,
      widthPercent: 10,
      position: "bottom-right",
      margin: 16,
      opacity: 70,
      type: "text",
      text: "hello",
    },
    services: { images: { sharp } } as InstanceServices,
  });
  const input = {
    params: {},
    limits: { maxDimension: 1000, maxPixels: 1_000_000 },
    file: {
      metadata: {
        mimeType: "image/svg+xml",
        byteSize: 20,
        width: 10,
        height: 10,
      },
      async openRead() {
        throw new Error("Must not read");
      },
    },
  };
  const context = {
    signal: new AbortController().signal,
    requestId: "test",
    log() {},
    data: {
      get() {
        return undefined;
      },
    },
  };
  expect(
    (
      await runtime.check(
        {
          metadata: input.file.metadata,
          getFile: async () => input.file,
          params: input.params,
          limits: input.limits,
        },
        context,
      )
    ).status,
  ).toBe("unsupported");
  expect(
    (
      await runtime.check(
        {
          metadata: input.file.metadata,
          getFile: async () => {
            throw new Error("Must not load");
          },
          params: { watermarkOpacity: 0 },
          limits: input.limits,
        },
        context,
      )
    ).status,
  ).toBe("noop");
  expect(
    (
      await runtime.check(
        {
          ...input,
          metadata: input.file.metadata,
          getFile: async () => ({
            ...input.file,
            metadata: {
              ...input.file.metadata,
              mimeType: "image/webp",
              animated: true,
            },
          }),
        },
        context,
      )
    ).status,
  ).toBe("unsupported");
});

test("watermark overrides validate merged sizing and leave instance settings unchanged", async () => {
  for (const stage of [watermark.stages.upload!, watermark.stages.access!]) {
    const config = {
      type: "text",
      text: "Default",
      font: "sans",
      color: "#ffffff",
      sizeMode: "relative",
      fontSizePercent: 3,
      marginPercent: 2,
      position: "bottom-right",
      opacity: 70,
    };
    const runtime = await stage.createInstance({
      id: "overrides",
      config,
      services: { images: { sharp } } as InstanceServices,
    });
    const input = {
      file: { metadata: { mimeType: "image/png" } },
      limits: { maxDimension: 1000, maxPixels: 1_000_000 },
    };
    const check = (params: Record<string, string | number>) =>
      runtime.check({ ...input, params } as any, {} as any);
    expect(stage.paramsSchema!.properties).not.toHaveProperty("watermark");
    expect(
      requestParameters(
        stage.paramsSchema,
        ["watermarkOpacity"],
        { watermarkOpacity: 0, watermarkText: "Ignored" },
        "body",
      ),
    ).toEqual({ watermarkOpacity: 0 });
    expect(() =>
      requestParameters(
        stage.paramsSchema,
        ["watermarkOpacity"],
        { watermarkOpacity: 101 },
        "body",
      ),
    ).toThrow();
    expect((await check({ watermarkText: " " })).status).toBe("noop");
    expect(
      (await check({ watermarkText: "", watermarkSizeMode: "fixed" })).status,
    ).toBe("noop");
    await expect(check({ watermarkSizeMode: "fixed" })).rejects.toThrow(
      "fontSize",
    );
    await expect(
      check({ watermarkSizeMode: "fixed", watermarkFontSize: 12 }),
    ).rejects.toThrow("margin");
    expect(
      (
        await check({
          watermarkSizeMode: "fixed",
          watermarkFontSize: 12,
          watermarkMargin: 0,
        })
      ).status,
    ).toBe("applicable");
    expect((await check({ watermarkOpacity: 0 })).status).toBe("noop");
    expect((await check({})).status).toBe("applicable");
    expect(config).toMatchObject({
      text: "Default",
      opacity: 70,
      sizeMode: "relative",
    });
    expect(config).not.toHaveProperty("fontSize");
    const { text: _, ...withoutText } = config;
    expect(await stage.validateConfig!(withoutText)).toEqual([]);
    const empty = await stage.createInstance({
      id: "empty",
      config: withoutText,
      services: { images: { sharp } } as InstanceServices,
    });
    expect(
      (await empty.check({ ...input, params: {} } as any, {} as any)).status,
    ).toBe("noop");
    expect(
      (
        await empty.check(
          { ...input, params: { watermarkText: "From request" } } as any,
          {} as any,
        )
      ).status,
    ).toBe("applicable");
  }
});

test("relative text and margin scale with the short side; fixed mode preserves pixel size", async () => {
  const f = await fixture();
  try {
    async function bounds(width: number, height: number, mode: string) {
      const runtime = await watermark.stages.upload!.createInstance({
        id: "size",
        config: {
          font: "sans",
          imageWidth: 128,
          widthPercent: 10,
          position: "bottom-right",
          type: "text",
          text: "Star",
          sizeMode: mode,
          fontSize: 20,
          fontSizePercent: 10,
          margin: 4,
          marginPercent: 5,
          opacity: 100,
          color: "#ffffff",
        },
        services: { images: { sharp } } as InstanceServices,
      });
      const source = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      const path = join(f.root, `size-${width}-${height}-${mode}.png`);
      await runtime.process(
        {
          record: {
            id: "test-image",
            createdAt: 1,
            origin: { kind: "upload", userId: null },
            ownerId: null,
            organization: { tags: [], collections: [] },
          },
          file: {
            metadata: {
              mimeType: "image/png",
              width,
              height,
              byteSize: source.length,
            },
            async openRead() {
              return new Blob([new Uint8Array(source)]).stream();
            },
          },
          params: {},
          limits: { maxDimension: 2000, maxPixels: 4_000_000 },
          async createOutput() {
            return {
              async write(stream: ReadableStream<Uint8Array>) {
                await Bun.write(path, new Response(stream));
              },
            } as any;
          },
        },
        {
          signal: new AbortController().signal,
          requestId: "size",
          organization: {
            async listTags() {
              return { items: [], total: 0 };
            },
            async listCollections() {
              return { items: [], total: 0 };
            },
            async ensureTag() {
              throw Error("Unexpected create");
            },
            async ensureCollection() {
              throw Error("Unexpected create");
            },
          },
          log() {},
          data: {
            get() {
              return undefined;
            },
            set() {},
          },
        },
      );
      const pixels = await sharp(path).ensureAlpha().raw().toBuffer();
      const points = [];
      for (let i = 3; i < pixels.length; i += 4)
        if (pixels[i]! > 0) points.push((i - 3) / 4);
      const xs = points.map((p) => p % width),
        ys = points.map((p) => Math.floor(p / width));
      return {
        width: Math.max(...xs) - Math.min(...xs) + 1,
        margin: height - 1 - Math.max(...ys),
      };
    }
    const small = await bounds(400, 200, "relative"),
      large = await bounds(800, 400, "relative");
    expect(large.width / small.width).toBeGreaterThan(1.8);
    expect(small.margin).toBe(10);
    expect(large.margin).toBe(20);
    const fixed = await bounds(800, 400, "fixed");
    expect(fixed.width).toBe(small.width);
    expect(fixed.margin).toBe(4);
    expect((await bounds(200, 400, "relative")).width).toBe(small.width);
  } finally {
    await f.close();
  }
});

test("watermark positions use EXIF-oriented dimensions without a raw base image", async () => {
  const f = await fixture();
  try {
    const logo = join(f.root, "oriented-mark.png");
    await sharp({
      create: { width: 6, height: 6, channels: 3, background: "red" },
    })
      .png()
      .toFile(logo);
    const pipeline = await f.app.configuration.savePipeline({
      name: "Oriented",
      kind: "upload",
      steps: [
        {
          pluginId: "builtin.watermark",
          enabledParams: [
            "watermarkPosition",
            "watermarkImageWidth",
            "watermarkMargin",
          ],
          onNotApplicable: "abort",
          version: "1.0.0",
          config: {
            font: "sans",
            fontSizePercent: 3,
            marginPercent: 2,
            fontSize: 32,
            color: "#ffffff",
            widthPercent: 10,
            type: "image",
            sizeMode: "fixed",
            imagePath: logo,
            imageWidth: 2,
            margin: 0,
            opacity: 100,
            position: "top-left",
          },
        },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        uploadPipelineId: pipeline.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const source = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "black" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    form.set("profileId", profile.id);
    form.set("file", new File([new Uint8Array(source)], "oriented.jpg"));
    form.set(
      "params",
      JSON.stringify({
        watermarkPosition: "bottom-right",
        watermarkImageWidth: 6,
        watermarkMargin: 0,
      }),
    );
    const response = await f.request("/api/files", "POST", form);
    expect(response.status).toBe(201);
    const uploaded = await response.json();
    const result = await f.request(new URL(uploaded.url).pathname);
    const { data, info } = await sharp(await result.arrayBuffer())
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 40]);
    const offset =
      ((info.height - 3) * info.width + info.width - 3) * info.channels;
    expect(data[offset]!).toBeGreaterThan(200);
    expect(data[offset + 1]!).toBeLessThan(50);
    expect(data[0]!).toBeLessThan(20);
  } finally {
    await f.close();
  }
});
