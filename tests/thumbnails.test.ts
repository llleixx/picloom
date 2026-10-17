import { test, expect, spyOn } from "bun:test";
import sharp from "sharp";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";

test("thumbnail is authenticated, cached across restart and independent of access pipeline", async () => {
  const f = await fixture();
  try {
    const input = await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 4,
        background: { r: 80, g: 160, b: 30, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const uploaded = await (await f.upload(undefined, input)).json();
    const path = `/api/files/${uploaded.id}/thumbnail`;
    const handle = handler(f.app);
    expect((await handle(new Request("http://localhost" + path))).status).toBe(
      401,
    );
    const token = await (
      await f.request("/api/tokens", "POST", { name: "uploader" })
    ).json();
    expect((await f.request(path, "GET", undefined, token.token)).status).toBe(
      403,
    );
    // Remove the access chain entirely: thumbnail generation is independent.
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      { ...access, steps: [], expectedVersion: access.configVersion },
      access.id,
    );
    const reads = spyOn(f.app.files as any, "read");
    const [a, b] = await Promise.all([f.request(path), f.request(path)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]![1]).toBe("stream");
    const bytes = Buffer.from(await a.arrayBuffer());
    await b.arrayBuffer();
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(240);
    expect(meta.hasAlpha).toBe(true);
    expect(a.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
    const etag = a.headers.get("etag")!;
    expect((await f.request(path, "HEAD")).body).toBeNull();
    const conditional = await handle(
      new Request("http://localhost" + path, {
        headers: { cookie: f.cookie, "if-none-match": etag },
      }),
    );
    expect(conditional.status).toBe(304);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    await f.restart();
    expect((await f.request(path)).headers.get("etag")).toBe(etag);
    await f.request("/api/files/" + uploaded.id, "DELETE");
    expect((await f.request(path)).status).toBe(404);
    await f.app.files.sweep();
    expect(await readdir(join(f.root, "cache"))).not.toContain(uploaded.id);
  } finally {
    await f.close();
  }
});

test("SVG and animated WebP become static thumbnails; small images are not enlarged", async () => {
  const f = await fixture();
  try {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="40" height="40" fill="red"/></svg>',
    );
    const pixels = Buffer.alloc(20 * 40 * 4);
    for (let i = 0; i < 20 * 40; i++) {
      pixels[i * 4 + (i < 400 ? 0 : 1)] = 255;
      pixels[i * 4 + 3] = 255;
    }
    const animation = await sharp(pixels, {
      raw: { width: 20, height: 40, channels: 4, pageHeight: 20 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animation, { animated: true }).metadata()).pages).toBe(
      2,
    );
    for (const [input, width, height] of [
      [svg, 80, 40],
      [animation, 20, 20],
    ] as const) {
      const file = await (await f.upload(undefined, input)).json();
      const response = await f.request(`/api/files/${file.id}/thumbnail`);
      expect(response.status).toBe(200);
      const meta = await sharp(Buffer.from(await response.arrayBuffer()), {
        animated: true,
      }).metadata();
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
      expect(meta.pages ?? 1).toBe(1);
    }
  } finally {
    await f.close();
  }
});

test.each(["thumbnail", "transform"])(
  "deletion during %s generation prevents cache publication and releases temporary files",
  async (kind) => {
    const f = await fixture();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    try {
      const uploaded = await (await f.upload()).json();
      const files = f.app.files as any;
      const original = files.read.bind(files);
      const read = spyOn(files, "read").mockImplementation(
        async (...args: any[]) => {
          const value = await original(...args);
          started();
          await gate;
          return value;
        },
      );
      const pending = f.request(
        kind === "thumbnail"
          ? `/api/files/${uploaded.id}/thumbnail`
          : new URL(uploaded.url).pathname + "?w=20",
      );
      await entered;
      await f.request(`/api/files/${uploaded.id}`, "DELETE");
      unblock();
      expect((await pending).status).toBe(404);
      read.mockRestore();
      await f.app.files.sweep();
      expect(await readdir(join(f.root, "temp"))).toEqual([]);
      expect(await readdir(join(f.root, "cache"))).not.toContain(uploaded.id);
    } finally {
      unblock();
      await f.close();
    }
  },
);

test("thumbnail decode limits reject oversized sources without caching", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    f.app.config.maxPixels = 1;
    expect(
      (await f.request(`/api/files/${uploaded.id}/thumbnail`)).status,
    ).toBe(415);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
    expect(await readdir(join(f.root, "cache"))).not.toContain(uploaded.id);
  } finally {
    await f.close();
  }
});
