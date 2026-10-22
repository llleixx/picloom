import { test, expect } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";

// Asymmetric pixels catch both rotation and mirroring, not just dimensions.
async function photo(orientation: number) {
  const pixels = Buffer.alloc(80 * 40 * 3);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 80; x++)
      pixels[(y * 80 + x) * 3 + (x < 40 ? 0 : 2)] = 255;
  return sharp(pixels, { raw: { width: 80, height: 40, channels: 3 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 100 })
    .toBuffer();
}
async function check(
  bytes: Buffer,
  width: number,
  height: number,
  topLeft: number,
) {
  const meta = await sharp(bytes).metadata();
  expect([meta.width, meta.height]).toEqual([width, height]);
  expect(meta.orientation).toBeUndefined();
  const { data, info } = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[(4 * info.width + 4) * info.channels + topLeft]).toBeGreaterThan(
    220,
  );
}

test("EXIF display dimensions, original bytes, thumbnails and access transforms agree", async () => {
  const f = await fixture();
  try {
    for (const orientation of [2, 6]) {
      const input = await photo(orientation);
      const uploaded = await (await f.upload(undefined, input)).json();
      const path = new URL(uploaded.url).pathname;
      const details = await (
        await f.request(`/api/files/${uploaded.id}`)
      ).json();
      const [width, height] = orientation === 6 ? [40, 80] : [80, 40];
      const color = orientation === 6 ? 0 : 2;
      expect([details.width, details.height]).toEqual([width, height]);
      expect(Buffer.from(await (await f.request(path)).arrayBuffer())).toEqual(
        Buffer.from(input),
      );
      await check(
        Buffer.from(
          await (
            await f.request(`/api/files/${uploaded.id}/thumbnail`)
          ).arrayBuffer(),
        ),
        width!,
        height!,
        color,
      );
      await check(
        Buffer.from(
          await (await f.request(path + "?w=20&format=png")).arrayBuffer(),
        ),
        20,
        orientation === 6 ? 40 : 10,
        color,
      );
    }
  } finally {
    await f.close();
  }
});

test("upload transform applies orientation before cover cropping and persists output dimensions", async () => {
  const f = await fixture();
  try {
    const pipeline = await f.app.configuration.savePipeline({
      name: "Oriented crop",
      kind: "upload",
      steps: [
        {
          pluginId: "builtin.sharp",
          version: "1.0.0",
          config: {
            w: 20,
            h: 30,
            fit: "cover",
            format: "png",
          },
          onNotApplicable: "abort",
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
    const response = await f.upload(undefined, await photo(6));
    expect(response.status).toBe(201);
    const file = await response.json();
    const details = await (await f.request(`/api/files/${file.id}`)).json();
    expect([details.width, details.height]).toEqual([20, 30]);
    await check(
      Buffer.from(
        await (await f.request(new URL(file.url).pathname)).arrayBuffer(),
      ),
      20,
      30,
      0,
    );
  } finally {
    await f.close();
  }
});
