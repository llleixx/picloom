import { multipartWrite } from "./s3-multipart";
import { isPluginError } from "../../plugin-sdk";
import { scanScope, decodeCursor, encodeCursor } from "./enumeration";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { PluginError, type Definition, type Locator } from "../../plugin-sdk";
import { logicalKey as storageKey } from "../../plugin-sdk";
export const s3Storage: Definition<"storage"> = {
  id: "builtin.s3",
  name: "S3-compatible storage",
  translations: {
    "zh-CN": {
      name: "S3 兼容存储",
      configSchema: {
        "/properties/multipartThresholdMiB": { title: "分片阈值（MiB）" },
        "/properties/partSizeMiB": { title: "分片大小（MiB）" },
        "/properties/partConcurrency": { title: "分片并发数" },
        "/properties/endpoint": { title: "端点" },
        "/properties/region": { title: "区域" },
        "/properties/bucket": { title: "存储桶" },
        "/properties/keyPrefix": { title: "对象前缀" },
        "/properties/forcePathStyle": { title: "路径寻址" },
        "/properties/accessKeyId": { title: "访问密钥 ID" },
        "/properties/secretAccessKey": { title: "访问密钥" },
        "/properties/sessionToken": { title: "会话令牌" },
        "/properties/redirect": { title: "302 重定向" },
        "/properties/signedUrlSeconds": { title: "签名链接有效期（秒）" },
      },
    },
  },
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      multipartThresholdMiB: {
        type: "integer",
        title: "Multipart threshold (MiB)",
        minimum: 5,
        maximum: 5120,
        default: 64,
      },
      partSizeMiB: {
        type: "integer",
        title: "Part size (MiB)",
        minimum: 5,
        maximum: 512,
        default: 16,
      },
      partConcurrency: {
        type: "integer",
        title: "Part concurrency",
        minimum: 1,
        maximum: 8,
        default: 3,
      },
      endpoint: {
        type: "string",
        title: "Endpoint",
        format: "uri",
        "x-immutable": true,
      },
      region: {
        type: "string",
        title: "Region",
        default: "us-east-1",
        minLength: 1,
        "x-immutable": true,
      },
      bucket: {
        type: "string",
        title: "Bucket",
        minLength: 1,
        "x-immutable": true,
      },
      keyPrefix: {
        type: "string",
        title: "Object prefix",
        default: "",
        "x-immutable": true,
      },
      forcePathStyle: {
        type: "boolean",
        title: "Path-style addressing",
        default: true,
        "x-immutable": true,
      },
      accessKeyId: {
        type: "string",
        title: "Access Key ID",
        minLength: 1,
        "x-sensitive": true,
      },
      secretAccessKey: {
        type: "string",
        title: "Secret Access Key",
        minLength: 1,
        "x-sensitive": true,
      },
      sessionToken: {
        type: "string",
        title: "Session Token",
        "x-sensitive": true,
      },
      redirect: {
        type: "boolean",
        title: "Redirect reads (302)",
        default: false,
      },
      signedUrlSeconds: {
        type: "integer",
        title: "Signed URL lifetime (seconds)",
        minimum: 1,
        maximum: 604800,
        default: 300,
      },
    },
    required: ["region", "bucket", "accessKeyId", "secretAccessKey"],
    additionalProperties: false,
  },
  uiHints: {
    "/multipartThresholdMiB": { advanced: true },
    "/partSizeMiB": { advanced: true },
    "/partConcurrency": { advanced: true },
    "/signedUrlSeconds": { visibleWhen: { path: "/redirect", equals: true } },
    "/sessionToken": { advanced: true },
    "/keyPrefix": { advanced: true },
  },
  async validateConfig(config) {
    if (config.endpoint) {
      try {
        const u = new URL(String(config.endpoint));
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw 0;
      } catch {
        return [{ path: "/endpoint", message: "Invalid endpoint" }];
      }
    }
    const p = String(config.keyPrefix ?? "");
    if (
      p &&
      (p.startsWith("/") ||
        p.endsWith("/") ||
        p.split("/").some((x) => !x || x === "." || x === ".."))
    )
      return [{ path: "/keyPrefix", message: "Invalid object prefix" }];
    return [];
  },
  async createInstance({ config, services }) {
    const secret = (await services.readSecrets()).value;
    const client = new S3Client({
      endpoint: config.endpoint ? String(config.endpoint) : undefined,
      region: String(config.region),
      forcePathStyle: Boolean(config.forcePathStyle),
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: String(secret.accessKeyId),
        secretAccessKey: String(secret.secretAccessKey),
        sessionToken: secret.sessionToken
          ? String(secret.sessionToken)
          : undefined,
      },
    });
    const bucket = String(config.bucket),
      prefix = String(config.keyPrefix ?? "");
    const key = (logical: string, locator: Locator) =>
      locator === null
        ? `${prefix ? prefix + "/" : ""}${storageKey(logical)}`
        : typeof locator === "object" && typeof locator.key === "string"
          ? locator.key
          : (() => {
              throw new PluginError(
                "LOCATOR",
                "Invalid S3 locator",
                false,
                "notApplied",
              );
            })();
    const recover = async (
      operationId: string,
      fileId: string,
      logical: string,
      size: number,
      signal: AbortSignal,
    ) => {
      const k = key(logical, null);
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: k }),
          { abortSignal: signal },
        );
        return result.Metadata?.operation === operationId &&
          result.Metadata?.file === fileId &&
          result.ContentLength === size
          ? { status: "stored" as const, locator: null }
          : { status: "unknown" as const };
      } catch (e) {
        return (e as { $metadata?: { httpStatusCode: number } }).$metadata
          ?.httpStatusCode === 404
          ? { status: "notStored" as const }
          : { status: "unknown" as const };
      }
    };
    return {
      async listFiles({ scope: inputScope, cursor, limit }, ctx) {
        scanScope(inputScope);
        const scope = inputScope ?? "";
        const token = decodeCursor<string>(cursor, scope);
        if (token !== undefined && typeof token !== "string")
          throw new PluginError("INVALID_CURSOR", "Invalid scan cursor");
        const base = prefix ? prefix + "/" : "";
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: base + scope,
            MaxKeys: Math.min(limit, 1000),
            ContinuationToken: token,
          }),
          { abortSignal: ctx.signal },
        );
        if (result.IsTruncated && !result.NextContinuationToken)
          throw new PluginError("PLUGIN_RESULT", "Missing continuation token");
        return {
          items: (result.Contents ?? [])
            .filter((o) => o.Key?.startsWith(base) && !o.Key.endsWith("/"))
            .map((o) => ({
              storageKey: o.Key!.slice(base.length),
              byteSize: o.Size,
            })),
          nextCursor: result.IsTruncated
            ? encodeCursor(scope, result.NextContinuationToken)
            : null,
        };
      },
      async write({ operationId, fileId, storageKey: logical, file }, ctx) {
        const size = file.metadata.byteSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw new PluginError(
            "S3_SIZE",
            "S3 upload requires a known non-negative size",
            false,
            "notApplied",
          );
        let body: Readable | undefined;
        try {
          if (size >= Number(config.multipartThresholdMiB ?? 64) * 1024 ** 2) {
            await multipartWrite(
              client,
              {
                Bucket: bucket,
                Key: key(logical, null),
                ContentType: file.metadata.mimeType ?? undefined,
                Metadata: { operation: operationId, file: fileId },
              },
              file,
              Number(config.partSizeMiB ?? 16) * 1024 ** 2,
              Number(config.partConcurrency ?? 3),
              ctx,
            );
            return { locator: null };
          }
          body = Readable.fromWeb(
            (await file.openRead()) as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key(logical, null),
              IfNoneMatch: "*",
              Body: body,
              ContentLength: size,
              ContentType: file.metadata.mimeType ?? undefined,
              Metadata: { operation: operationId, file: fileId },
            }),
            { abortSignal: ctx.signal },
          );
          return { locator: null };
        } catch (e) {
          if (isPluginError(e)) throw e;
          const status = (e as { $metadata?: { httpStatusCode: number } })
            .$metadata?.httpStatusCode;
          if (status === 412) {
            const result = await recover(
              operationId,
              fileId,
              logical,
              size,
              ctx.signal,
            );
            if (result.status === "stored") return { locator: result.locator };
            throw new PluginError(
              "S3_CONFLICT",
              "S3 对象已被其他操作占用",
              false,
              "notApplied",
            );
          }
          throw new PluginError(
            "S3_WRITE",
            "S3 写入失败",
            status === undefined ||
              status === 409 ||
              status === 429 ||
              status >= 500,
            status !== undefined && status >= 400 && status < 500
              ? "notApplied"
              : "unknown",
          );
        } finally {
          body?.destroy();
        }
      },
      async read({ storageKey: logical, locator, mode }, ctx) {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key(logical, locator),
        });
        if (mode === "auto" && config.redirect) {
          const seconds = Number(config.signedUrlSeconds);
          return {
            type: "redirect" as const,
            url: await getSignedUrl(client, command, { expiresIn: seconds }),
            expiresAt: Date.now() + seconds * 1000,
          };
        }
        try {
          const result = await client.send(command, {
            abortSignal: ctx.signal,
          });
          if (!result.Body) throw new Error();
          return {
            type: "stream" as const,
            stream: result.Body.transformToWebStream(),
            mimeType: result.ContentType,
            byteSize: result.ContentLength,
          };
        } catch {
          throw new PluginError("S3_READ", "S3 读取失败", true);
        }
      },
      async delete({ storageKey: logical, locator }, ctx) {
        try {
          await client.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key(logical, locator),
            }),
            { abortSignal: ctx.signal },
          );
        } catch {
          throw new PluginError("S3_DELETE", "S3 删除失败", true);
        }
      },
      async recoverWrite(input, ctx) {
        return recover(
          input.operationId,
          input.fileId,
          input.storageKey,
          input.expectedSize,
          ctx.signal,
        );
      },
      dispose() {
        client.destroy();
      },
    };
  },
};
