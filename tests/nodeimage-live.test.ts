import { test, expect } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
const enabled = !!process.env.NODEIMAGE_TEST_KEY;
(enabled ? test : test.skip)(
  "real NodeImage upload, redirect, stream and deletion capability",
  async () => {
    const f = await fixture();
    const source = await f.app.plugins.save({
      pluginId: "builtin.nodeimage",
      version: "1.0.0",
      name: "Live NodeImage",
      config: { redirect: true, timeoutMs: 30000 },
      secretEdits: {
        "/apiKey": {
          action: "replace",
          value: process.env.NODEIMAGE_TEST_KEY!,
        },
      },
    });
    const lease = f.app.plugins.acquire(source.id, "storage");
    const ctx = {
      signal: AbortSignal.timeout(30000),
      requestId: "nodeimage-live",
      log() {},
    };
    const storageKey = "nodeimage-live.png";
    try {
      const existing = process.env.NODEIMAGE_TEST_LOCATOR;
      const { locator = null } = existing
        ? { locator: JSON.parse(existing) }
        : await lease.runtime.write(
            {
              fileId: crypto.randomUUID(),
              operationId: crypto.randomUUID(),
              storageKey,
              file: {
                metadata: {
                  mimeType: "image/png",
                  byteSize: f.png.length,
                  width: 40,
                  height: 20,
                },
                async openRead() {
                  return new Blob([new Uint8Array(f.png)]).stream();
                },
              },
            },
            ctx,
          );
      expect(locator).not.toBeNull();
      const redirected = await lease.runtime.read(
        { storageKey, locator, mode: "auto" },
        ctx,
      );
      expect(redirected.type).toBe("redirect");
      const streamed = await lease.runtime.read(
        { storageKey, locator, mode: "stream" },
        ctx,
      );
      if (streamed.type !== "stream") throw Error("Expected stream");
      const bytes = Buffer.from(
        await new Response(streamed.stream).arrayBuffer(),
      );
      const resized = await sharp(bytes).resize({ width: 16 }).png().toBuffer();
      expect((await sharp(resized).metadata()).width).toBe(16);
      try {
        await lease.runtime.delete(
          { storageKey, locator, operationId: crypto.randomUUID() },
          ctx,
        );
        console.log("NodeImage test object deleted");
      } catch (error: any) {
        expect(error.code).toBe("UNSUPPORTED");
        console.log(
          "NodeImage test object retained: API deletion unavailable",
          JSON.stringify(locator),
        );
      }
    } finally {
      await lease.release();
      await f.close();
    }
  },
  60000,
);
