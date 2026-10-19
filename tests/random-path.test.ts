import sharp from "sharp";
import { expect, test } from "bun:test";
import { randomPath } from "../src/builtins/path/random-path/index";
import {
  PluginError,
  type InstanceServices,
  type PathPlugin,
} from "../src/plugins/api";

const services: InstanceServices = {
  images: { sharp },
  log() {},
  async readSecrets() {
    throw new Error("Random path must not read secrets");
  },
  async updateSecrets() {
    throw new Error("Random path must not update secrets");
  },
  async readState() {
    throw new Error("Random path must not read state");
  },
  async updateState() {
    throw new Error("Random path must not update state");
  },
};
const context = {
  signal: new AbortController().signal,
  requestId: "random-path-test",
  log() {},
};
const input: Parameters<PathPlugin["generate"]>[0] = {
  fileId: "ceab7c0c-35c8-4c66-b50a-27b78a2a6596",
  uploadedAt: Date.UTC(2026, 9, 16),
  originalName: "private-original-name.jpeg",
  metadata: {
    mimeType: "image/webp",
    byteSize: 123,
    width: 10,
    height: 10,
  },
};
const runtime = () =>
  randomPath.createInstance({ id: "test", config: {}, services });

test("random path is stable across instances and hides dates and source filenames", async () => {
  const first = await runtime();
  const { logicalKey: path } = await first.generate(input, context);
  expect(path).toMatch(/^[0-9a-f]{32}\.webp$/);
  expect(path).not.toContain("2026");
  expect(path).not.toContain("private-original-name");
  expect(path).toBe(input.fileId.replaceAll("-", "") + ".webp");
  expect(
    await (
      await runtime()
    ).generate(
      { ...input, uploadedAt: 0, originalName: "another.png" },
      context,
    ),
  ).toEqual({ logicalKey: path, storageKey: "ce/ab/" + path });
  expect(
    await first.generate({ ...input, fileId: crypto.randomUUID() }, context),
  ).not.toMatchObject({ logicalKey: path });
});

test("random path uses the final image MIME type for every supported extension", async () => {
  const plugin = await runtime();
  const formats = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/tiff": "tiff",
  };
  for (const [mimeType, ext] of Object.entries(formats)) {
    const { logicalKey: path } = await plugin.generate(
      { ...input, metadata: { ...input.metadata, mimeType } },
      context,
    );
    expect(path).toMatch(new RegExp("^[0-9a-f]{32}\\." + ext + "$"));
  }
});

test("random path rejects missing and unsupported MIME types instead of using a source extension", async () => {
  const plugin = await runtime();
  for (const mimeType of [null, "text/plain", "image/../../other"]) {
    await expect(
      plugin.generate(
        { ...input, metadata: { ...input.metadata, mimeType } },
        context,
      ),
    ).rejects.toBeInstanceOf(PluginError);
  }
});

test("random path directory depth changes only the storage key", async () => {
  for (const directoryDepth of [0, 1, 2]) {
    const plugin = await randomPath.createInstance({
      id: "test",
      config: { directoryDepth },
      services,
    });
    const result = await plugin.generate(input, context);
    const name = input.fileId.replaceAll("-", "") + ".webp";
    expect(result).toEqual(
      directoryDepth === 0
        ? { logicalKey: name }
        : {
            logicalKey: name,
            storageKey: (directoryDepth === 1 ? "ce/" : "ce/ab/") + name,
          },
    );
  }
});
