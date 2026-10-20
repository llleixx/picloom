import { multipartWrite } from "./multipart";
import { isPluginError, retainStream } from "../../../../plugin-sdk";
import { scanScope, decodeCursor, encodeCursor } from "../shared/enumeration";
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
import {
  PluginError,
  type Definition,
  type Locator,
} from "../../../../plugin-sdk";
import { logicalKey as storageKey } from "../../../../plugin-sdk";
function failureCode(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409 || status === 412) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return status === undefined ? "NETWORK" : "SERVICE";
}
export const s3Storage: Definition<"storage"> = {
  defaultLocale: "en-US",
  content: {
    "en-US": {
      name: "S3-Compatible Storage",
      description: "Store files in an S3-compatible bucket.",
      configSchema: {
        "/properties/multipartThresholdMiB": {
          title: "Multipart threshold (MiB)",
        },
        "/properties/partSizeMiB": { title: "Part size (MiB)" },
        "/properties/partConcurrency": { title: "Part concurrency" },
        "/properties/endpoint": { title: "Endpoint" },
        "/properties/region": { title: "Region" },
        "/properties/bucket": { title: "Bucket" },
        "/properties/keyPrefix": {
          title: "Object prefix",
          description:
            "Prefix all stored object keys; leave empty to add no prefix.",
        },
        "/properties/forcePathStyle": {
          title: "Path-style addressing",
          description:
            "Use endpoint/bucket URLs; follow your storage provider’s requirements.",
        },
        "/properties/accessKeyId": { title: "Access Key ID" },
        "/properties/secretAccessKey": { title: "Secret Access Key" },
        "/properties/sessionToken": { title: "Session Token" },
        "/properties/redirect": { title: "Redirect reads (302)" },
        "/properties/signedUrlSeconds": {
          title: "Signed URL lifetime (seconds)",
        },
      },
    },
    "zh-CN": {
      name: "S3 兼容存储",
      description: "将文件保存到 S3 兼容存储桶。",
      configSchema: {
        "/properties/multipartThresholdMiB": { title: "分片阈值（MiB）" },
        "/properties/partSizeMiB": { title: "分片大小（MiB）" },
        "/properties/partConcurrency": { title: "分片并发数" },
        "/properties/endpoint": { title: "端点" },
        "/properties/region": { title: "区域" },
        "/properties/bucket": { title: "存储桶" },
        "/properties/keyPrefix": {
          title: "对象前缀",
          description: "为所有存储对象添加统一路径前缀，留空不添加。",
        },
        "/properties/forcePathStyle": {
          title: "路径寻址",
          description: "使用端点/桶名形式访问，是否启用以服务商要求为准。",
        },
        "/properties/accessKeyId": { title: "访问密钥 ID" },
        "/properties/secretAccessKey": { title: "访问密钥" },
        "/properties/sessionToken": { title: "会话令牌" },
        "/properties/redirect": { title: "302 重定向" },
        "/properties/signedUrlSeconds": { title: "签名链接有效期（秒）" },
      },
    },
  },

  id: "builtin.s3",

  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      multipartThresholdMiB: {
        type: "integer",

        minimum: 5,
        maximum: 5120,
        default: 64,
      },
      partSizeMiB: {
        type: "integer",

        minimum: 5,
        maximum: 512,
        default: 16,
      },
      partConcurrency: {
        type: "integer",

        minimum: 1,
        maximum: 8,
        default: 3,
      },
      endpoint: {
        type: "string",

        format: "uri",
        "x-immutable": true,
      },
      region: {
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
      bucket: {
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
      keyPrefix: {
        type: "string",

        default: "",
        "x-immutable": true,
      },
      forcePathStyle: {
        type: "boolean",

        default: true,
        "x-immutable": true,
      },
      accessKeyId: {
        type: "string",

        minLength: 1,
        "x-sensitive": true,
      },
      secretAccessKey: {
        type: "string",

        minLength: 1,
        "x-sensitive": true,
      },
      sessionToken: {
        type: "string",

        "x-sensitive": true,
      },
      redirect: {
        type: "boolean",

        default: false,
      },
      signedUrlSeconds: {
        type: "integer",

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
                "INVALID_INPUT",
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
        ctx.signal.throwIfAborted();
        scanScope(inputScope);
        const scope = inputScope ?? "";
        const token = decodeCursor<string>(cursor, scope);
        if (token !== undefined && typeof token !== "string")
          throw new PluginError("INVALID_INPUT", "Invalid scan cursor");
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
          throw new PluginError("INVALID_DATA", "Missing continuation token");
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
        ctx.signal.throwIfAborted();
        const size = file.metadata.byteSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw new PluginError(
            "INVALID_INPUT",
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
              "CONFLICT",
              "S3 对象已被其他操作占用",
              false,
              "notApplied",
            );
          }
          throw new PluginError(
            failureCode(e),
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
        ctx.signal.throwIfAborted();
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
          if (!result.Body)
            throw new PluginError("INVALID_DATA", "Missing S3 response body");
          return {
            type: "stream" as const,
            stream: retainStream(
              result.Body.transformToWebStream(),
              () => {},
              ctx.signal,
            ),
            mimeType: result.ContentType,
            byteSize: result.ContentLength,
          };
        } catch (error) {
          ctx.signal.throwIfAborted();
          if (isPluginError(error)) throw error;
          throw new PluginError(failureCode(error), "S3 读取失败", true);
        }
      },
      async delete({ storageKey: logical, locator }, ctx) {
        ctx.signal.throwIfAborted();
        try {
          await client.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key(logical, locator),
            }),
            { abortSignal: ctx.signal },
          );
        } catch (error) {
          ctx.signal.throwIfAborted();
          if (isPluginError(error)) throw error;
          throw new PluginError(failureCode(error), "S3 删除失败", true);
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
