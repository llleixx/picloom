import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { test, expect } from "bun:test";
import { fixture } from "./helpers";
const enabled =
  !!process.env.S3_TEST_ENDPOINT &&
  !!process.env.S3_TEST_BUCKET &&
  !!process.env.S3_TEST_ACCESS_KEY &&
  !!process.env.S3_TEST_SECRET_KEY;
for (const multipart of [false, true])
  (enabled ? test : test.skip)(
    `real S3 compatible endpoint (${multipart ? "multipart" : "PUT"}): conditional write, stream, recovery, signed URL and cleanup`,
    async () => {
      const f = await fixture();
      const bytes = multipart ? Buffer.alloc(11 * 1024 ** 2, 42) : f.png;
      const objectKey = crypto.randomUUID() + ".png";
      let locator: import("../src/plugins/api").Locator = null;
      const record = await f.app.plugins.save({
        secretEdits: {
          "/accessKeyId": {
            action: "replace",
            value: process.env.S3_TEST_ACCESS_KEY!,
          },
          "/secretAccessKey": {
            action: "replace",
            value: process.env.S3_TEST_SECRET_KEY!,
          },
        },
        pluginId: "builtin.s3",
        version: "1.0.0",
        name: "S3 integration",
        config: {
          forcePathStyle: true,
          signedUrlSeconds: 300,
          endpoint: process.env.S3_TEST_ENDPOINT!,
          region: process.env.S3_TEST_REGION ?? "us-east-1",
          bucket: process.env.S3_TEST_BUCKET!,
          keyPrefix: "picloom-tests",

          multipartThresholdMiB: 5,
          partSizeMiB: 5,
          partConcurrency: 2,
          redirect: true,
        },
      });
      const lease = f.app.plugins.acquire(record.id, "storage"),
        fileId = crypto.randomUUID(),
        operationId = crypto.randomUUID(),
        ctx = {
          signal: AbortSignal.timeout(30000),
          requestId: "integration",
          log() {},
        },
        file = {
          metadata: {
            mimeType: "image/png",
            byteSize: bytes.length,
            width: 40,
            height: 20,
          },
          async openRead() {
            return new Blob([new Uint8Array(bytes)]).stream();
          },
        };
      try {
        locator =
          (
            await lease.runtime.write(
              { operationId, fileId, storageKey: objectKey, file },
              ctx,
            )
          ).locator ?? null;
        expect(
          (
            await lease.runtime.recoverWrite!(
              {
                operationId,
                fileId,
                storageKey: objectKey,
                expectedSize: bytes.length,
                locator,
              },
              ctx,
            )
          ).status,
        ).toBe("stored");
        await expect(
          lease.runtime.write(
            {
              operationId: "other-operation",
              fileId,
              storageKey: objectKey,
              file,
            },
            ctx,
          ),
        ).rejects.toThrow();
        const read = await lease.runtime.read(
          { storageKey: objectKey, locator, mode: "stream" },
          ctx,
        );
        expect(read.type).toBe("stream");
        if (read.type === "stream")
          expect(
            new Uint8Array(await new Response(read.stream).arrayBuffer()),
          ).toEqual(new Uint8Array(bytes));
        const signed = await lease.runtime.read(
          { storageKey: objectKey, locator, mode: "auto" },
          ctx,
        );
        expect(signed.type).toBe("redirect");
        if (signed.type === "redirect") {
          const response = await fetch(signed.url);
          expect(response.status).toBe(200);
          await response.arrayBuffer();
        }
      } finally {
        if (locator) {
          await lease.runtime.delete(
            {
              operationId: crypto.randomUUID(),
              storageKey: objectKey,
              locator,
            },
            ctx,
          );
          expect(
            (
              await lease.runtime.recoverWrite!(
                {
                  operationId,
                  fileId,
                  storageKey: objectKey,
                  expectedSize: bytes.length,
                  locator,
                },
                { ...ctx, signal: AbortSignal.timeout(30000) },
              )
            ).status,
          ).toBe("notStored");
        }
        await lease.release();
        await f.close();
      }
    },
    60000,
  );

(enabled ? test : test.skip)(
  "real S3 in-place import lists legacy keys and serves a signed URL",
  async () => {
    const f = await fixture();
    const prefix = "picloom-import-tests/" + crypto.randomUUID();
    const client = new S3Client({
      endpoint: process.env.S3_TEST_ENDPOINT!,
      region: process.env.S3_TEST_REGION ?? "us-east-1",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: process.env.S3_TEST_ACCESS_KEY!,
        secretAccessKey: process.env.S3_TEST_SECRET_KEY!,
      },
    });
    const Bucket = process.env.S3_TEST_BUCKET!,
      Key = prefix + "/legacy/a.png";
    try {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: f.png,
          ContentType: "image/png",
          IfNoneMatch: "*",
        }),
      );
      const src = await f.app.plugins.save({
        secretEdits: {
          "/accessKeyId": {
            action: "replace",
            value: process.env.S3_TEST_ACCESS_KEY!,
          },
          "/secretAccessKey": {
            action: "replace",
            value: process.env.S3_TEST_SECRET_KEY!,
          },
        },
        pluginId: "builtin.s3",
        version: "1.0.0",
        name: "Live import",
        config: {
          multipartThresholdMiB: 64,
          partSizeMiB: 16,
          partConcurrency: 3,
          signedUrlSeconds: 300,
          endpoint: process.env.S3_TEST_ENDPOINT!,
          region: process.env.S3_TEST_REGION ?? "us-east-1",
          bucket: Bucket,
          keyPrefix: prefix,
          forcePathStyle: true,

          redirect: true,
        },
      });
      const result = await f.request(
        `/api/storage-sources/${src.id}/import`,
        "POST",
        {
          scope: "legacy/",
          publicPrefix: "/legacy/",
          mimeTypes: ["image/png"],
        },
      );
      expect(result.status).toBe(200);
      expect((await result.json()).imported).toBe(1);
      const response = await f.request("/legacy/legacy/a.png");
      expect(response.status).toBe(302);
      const original = await fetch(response.headers.get("location")!);
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(
        new Uint8Array(f.png),
      );
      const processed = await f.request(
        "/legacy/legacy/a.png?w=10&format=webp",
      );
      expect(processed.status).toBe(200);
      await processed.arrayBuffer();
      const file = (await f.app.db.read((r) => r.files(10, 0)))[0]!;
      await f.request(`/api/files/${file.id}`, "DELETE");
      await f.app.files.tasks.sweep();
      expect((await f.app.db.read((r) => r.file(file.id)))?.status).toBe(
        "deleted",
      );
    } finally {
      await client
        .send(new DeleteObjectCommand({ Bucket, Key }))
        .finally(() => client.destroy());
      await f.close();
    }
  },
);
