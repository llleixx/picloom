import { test, expect } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
import { pipelineData } from "../src/core/pipeline-data";

const enabled = process.env.TENCENT_LIVE === "1";
(enabled ? test : test.skip)(
  "real Tencent Cloud moderation accepts an image and returns a summary",
  async () => {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    const bizType = process.env.TENCENT_BIZ_TYPE;
    if (!secretId || !secretKey || !bizType)
      throw new Error(
        "Set TENCENT_SECRET_ID, TENCENT_SECRET_KEY and TENCENT_BIZ_TYPE",
      );
    const f = await fixture();
    try {
      const record = await f.app.plugins.save({
        pluginId: "builtin.tencent-moderation",
        version: "1.0.0",
        stage: "post_save",
        name: "Tencent live",
        config: {
          submissionMode: "content",
          maxContentMiB: 5,
          blockAction: "block",
          timeoutMs: 30000,
          interval: 5,
          maxFrames: 5,
          bizType,
          region: process.env.TENCENT_REGION ?? "ap-guangzhou",
        },
        secretEdits: {
          "/secretId": { action: "replace", value: secretId },
          "/secretKey": { action: "replace", value: secretKey },
        },
      });
      const lease = f.app.plugins.acquire(record.id, "post_save");
      try {
        const png = await sharp({
          create: { width: 256, height: 256, channels: 3, background: "green" },
        })
          .png()
          .toBuffer();
        const result = await lease.runtime.execute(
          {
            operationId: "live-test",
            fileId: crypto.randomUUID(),
            url: "http://localhost/unused",
            publicPath: "/unused",
            currentStatus: "pass" as const,
            previousResults: [],
            file: {
              metadata: {
                mimeType: "image/png",
                byteSize: png.length,
                width: 256,
                height: 256,
              },
              async openRead() {
                return new Blob([new Uint8Array(png)]).stream();
              },
            },
          },
          {
            signal: new AbortController().signal,
            requestId: "live-test",
            data: pipelineData(),
            log() {},
          },
        );
        expect(["pass", "block", "delete"]).toContain(result.status);
        expect(typeof result.details?.requestId).toBe("string");
        expect(["Pass", "Review", "Block"]).toContain(
          String(result.details?.suggestion),
        );
      } finally {
        await lease.release();
      }
    } finally {
      await f.close();
    }
  },
  60000,
);
