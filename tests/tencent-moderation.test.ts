import { expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { fixture } from "./helpers";
import { pipelineData } from "../src/core/pipeline-data";
import { PluginError } from "../src/plugins/api";

test("Tencent Cloud signs file submissions, maps decisions, stores safe summaries and classifies errors", async () => {
  const f = await fixture();
  let expectedBytes = f.png;
  let suggestion = "Pass",
    code = "",
    calls = 0,
    malformed = false;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    calls++;
    expect(String(_url)).toBe("https://ims.tencentcloudapi.com");
    expect(init!.redirect).toBe("error");
    const headers = new Headers(init!.headers);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      BizType: "test",
      DataId: "file-id",
      Type: "IMAGE",
      Interval: 5,
      MaxFrames: 5,
    });
    expect(body.FileContent).toBe(expectedBytes.toString("base64"));
    expect(body.FileUrl).toBeUndefined();
    expect(headers.get("x-tc-action")).toBe("ImageModeration");
    expect(headers.get("x-tc-version")).toBe("2020-12-29");
    const date = new Date(Number(headers.get("x-tc-timestamp")) * 1000)
      .toISOString()
      .slice(0, 10);
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const canonical = [
      "POST",
      "/",
      "",
      "content-type:application/json\nhost:ims.tencentcloudapi.com\n",
      "content-type;host",
      digest(String(init!.body)),
    ].join("\n");
    let key = Buffer.from("TC3test-secret");
    for (const part of [date, "ims", "tc3_request"])
      key = Buffer.from(createHmac("sha256", key).update(part).digest());
    const sign = createHmac("sha256", key)
      .update(
        [
          "TC3-HMAC-SHA256",
          headers.get("x-tc-timestamp"),
          `${date}/ims/tc3_request`,
          digest(canonical),
        ].join("\n"),
      )
      .digest("hex");
    expect(headers.get("authorization")).toBe(
      `TC3-HMAC-SHA256 Credential=test-id/${date}/ims/tc3_request, SignedHeaders=content-type;host, Signature=${sign}`,
    );
    if (code)
      return Response.json({
        Response: {
          Error: { Code: code, Message: "Do not expose raw provider text" },
        },
      });
    if (malformed) return Response.json({ Response: {} });
    return Response.json({
      Response: {
        Suggestion: suggestion,
        Label: "Porn",
        SubLabel: "Test",
        Score: 82,
        RequestId: "request-id",
        LabelResults: [
          {
            Scene: "Porn",
            Label: "Porn",
            Score: 82,
            Suggestion: suggestion,
            Details: ["private"],
          },
        ],
        OcrResults: [{ Text: "private OCR text" }],
      },
    });
  }) as typeof fetch);
  try {
    const record = await f.app.plugins.save({
      pluginId: "builtin.tencent-moderation",
      version: "1.0.0",
      stage: "post_save",
      name: "Tencent",
      config: {
        region: "ap-guangzhou",
        submissionMode: "content",
        timeoutMs: 30000,
        interval: 5,
        maxFrames: 5,
        bizType: "test",
        blockAction: "delete",
        maxContentMiB: 8,
      },
      secretEdits: {
        "/secretId": { action: "replace", value: "test-id" },
        "/secretKey": { action: "replace", value: "test-secret" },
      },
    });
    expect(calls).toBe(0);
    const stored = await f.app.db.read((r) => r.instance(record.id));
    expect(JSON.stringify(stored!.config_json)).not.toContain("test-secret");
    expect(stored!.secrets_encrypted).not.toContain("test-secret");
    const lease = f.app.plugins.acquire(record.id, "post_save");
    const input = {
      operationId: "task:step",
      fileId: "file-id",
      url: "http://localhost/i/test.png",
      publicPath: "/i/test.png",
      currentStatus: "pass" as const,
      previousResults: [],
      file: {
        metadata: {
          mimeType: "image/png",
          byteSize: f.png.length,
          width: 40,
          height: 20,
        },
        async openRead() {
          return new Blob([new Uint8Array(expectedBytes)]).stream();
        },
      },
    };
    const ctx = {
      signal: new AbortController().signal,
      requestId: "test",
      data: pipelineData(),
      log() {},
    };
    try {
      for (const [value, action] of [
        ["Pass", "pass"],
        ["Review", "block"],
        ["Block", "delete"],
      ] as const) {
        suggestion = value!;
        const result = await lease.runtime.execute(input, ctx);
        expect(result.status).toBe(action);
        expect(result.details).toMatchObject({
          suggestion,
          label: "Porn",
          score: 82,
          requestId: "request-id",
        });
        expect(JSON.stringify(result)).not.toContain("private");
      }
      for (const [value, expected, retryable] of [
        ["AuthFailure.SignatureFailure", "ACCESS_DENIED", false],
        ["ResourceUnavailable.ImageDownloadError", "SERVICE", false],
        ["InvalidParameter.ImageSizeTooSmall", "INVALID_INPUT", false],
        ["RequestLimitExceeded", "RATE_LIMITED", true],
        ["InternalError", "SERVICE", true],
      ] as const) {
        code = value;
        try {
          await lease.runtime.execute(input, ctx);
          throw Error("Expected failure");
        } catch (error) {
          expect(error).toBeInstanceOf(PluginError);
          expect(error).toMatchObject({ code: expected, retryable });
        }
      }
      code = "";
      malformed = true;
      await expect(lease.runtime.execute(input, ctx)).rejects.toMatchObject({
        code: "INVALID_DATA",
        retryable: false,
      });
      malformed = false;
      expectedBytes = Buffer.alloc(8 * 1024 * 1024, 1);
      await expect(
        lease.runtime.execute(
          {
            ...input,
            file: {
              ...input.file,
              metadata: {
                ...input.file.metadata,
                byteSize: expectedBytes.length,
              },
            },
          },
          ctx,
        ),
      ).resolves.toMatchObject({ status: "delete" });
      const before = calls;
      const controller = new AbortController();
      controller.abort();
      await expect(
        lease.runtime.execute(input, { ...ctx, signal: controller.signal }),
      ).rejects.toBeDefined();
      expect(calls).toBe(before);
    } finally {
      await lease.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});

test("Tencent URL mode submits only the public URL without reading or resolving the file", async () => {
  const f = await fixture();
  let calls = 0;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    calls++;
    expect(String(url)).toBe("https://ims.tencentcloudapi.com");
    const body = JSON.parse(String(init!.body));
    expect(body.FileUrl).toBe("https://images.example.com/i/image%20name.svg");
    expect(body.FileContent).toBeUndefined();
    return Response.json({
      Response: { Suggestion: "Pass", RequestId: "url-test" },
    });
  }) as typeof fetch);
  try {
    const record = await f.app.plugins.save({
      pluginId: "builtin.tencent-moderation",
      version: "1.0.0",
      stage: "post_save",
      name: "Tencent URL",
      config: {
        region: "ap-guangzhou",
        maxContentMiB: 5,
        blockAction: "block",
        timeoutMs: 30000,
        interval: 5,
        maxFrames: 5,
        bizType: "test",
        submissionMode: "url",
      },
      secretEdits: {
        "/secretId": { action: "replace", value: "test-id" },
        "/secretKey": { action: "replace", value: "test-key" },
      },
    });
    expect(calls).toBe(0);
    const lease = f.app.plugins.acquire(record.id, "post_save");
    try {
      const result = await lease.runtime.execute(
        {
          operationId: "task:step",
          fileId: "file-id",
          publicPath: "/i/image%20name.svg",
          currentStatus: "pass" as const,
          previousResults: [],
          url: "https://images.example.com/i/image%20name.svg",
          file: {
            metadata: {
              mimeType: "image/svg+xml",
              byteSize: 40 * 1024 * 1024,
              width: null,
              height: null,
            },
            async openRead() {
              throw new Error("URL mode must not open the file");
            },
          },
        },
        {
          signal: new AbortController().signal,
          requestId: "test",
          data: pipelineData(),
          log() {},
        },
      );
      expect(result.status).toBe("pass");
      expect(calls).toBe(1);
    } finally {
      await lease.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});

test("content size limits reject declared and streamed oversize without contacting Tencent", async () => {
  const f = await fixture();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("Must not contact provider");
  }) as unknown as typeof fetch);
  try {
    const record = await f.app.plugins.save({
      pluginId: "builtin.tencent-moderation",
      version: "1.0.0",
      stage: "post_save",
      name: "Bounded",
      config: {
        region: "ap-guangzhou",
        submissionMode: "content",
        blockAction: "block",
        timeoutMs: 30000,
        interval: 5,
        maxFrames: 5,
        bizType: "test",
        maxContentMiB: 1,
      },
      secretEdits: {
        "/secretId": { action: "replace", value: "test-id" },
        "/secretKey": { action: "replace", value: "test-secret" },
      },
    });
    const lease = f.app.plugins.acquire(record.id, "post_save");
    let opens = 0,
      cancelled = false;
    const input = {
      operationId: "test",
      fileId: "file",
      url: "https://example.com/image",
      publicPath: "/image",
      currentStatus: "pass" as const,
      previousResults: [],
      file: {
        metadata: {
          mimeType: "image/png",
          byteSize: (1024 * 1024 + 1) as number | null,
          width: 1,
          height: 1,
        },
        async openRead() {
          opens++;
          return new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(new Uint8Array(600 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
        },
      },
    };
    const ctx = {
      signal: new AbortController().signal,
      requestId: "test",
      log() {},
      data: pipelineData(),
    };
    try {
      await expect(lease.runtime.execute(input, ctx)).rejects.toMatchObject({
        code: "RESOURCE_LIMIT",
        retryable: false,
      });
      expect(opens).toBe(0);
      input.file.metadata.byteSize = null;
      await expect(lease.runtime.execute(input, ctx)).rejects.toMatchObject({
        code: "RESOURCE_LIMIT",
        retryable: false,
      });
      expect(cancelled).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await lease.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});
