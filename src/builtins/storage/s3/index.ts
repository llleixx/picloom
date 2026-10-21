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
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "S3-Compatible Storage",
      "package.description": "Store files in an S3-compatible bucket.",
      "settings.multipartThresholdMiB.label": "Multipart threshold (MiB)",
      "settings.partSizeMiB.label": "Part size (MiB)",
      "settings.partConcurrency.label": "Part concurrency",
      "settings.endpoint.label": "Endpoint",
      "settings.region.label": "Region",
      "settings.bucket.label": "Bucket",
      "settings.keyPrefix.label": "Object prefix",
      "settings.keyPrefix.description":
        "Prefix all stored object keys; leave empty to add no prefix.",
      "settings.forcePathStyle.label": "Path-style addressing",
      "settings.forcePathStyle.description":
        "Use endpoint/bucket URLs; follow your storage provider’s requirements.",
      "settings.accessKeyId.label": "Access Key ID",
      "settings.secretAccessKey.label": "Secret Access Key",
      "settings.sessionToken.label": "Session Token",
      "settings.redirect.label": "Redirect reads (302)",
      "settings.signedUrlSeconds.label": "Signed URL lifetime (seconds)",
    },
    "zh-CN": {
      "package.name": "S3 兼容存储",
      "package.description": "将文件保存到 S3 兼容存储桶。",
      "settings.multipartThresholdMiB.label": "分片阈值（MiB）",
      "settings.partSizeMiB.label": "分片大小（MiB）",
      "settings.partConcurrency.label": "分片并发数",
      "settings.endpoint.label": "端点",
      "settings.region.label": "区域",
      "settings.bucket.label": "存储桶",
      "settings.keyPrefix.label": "对象前缀",
      "settings.keyPrefix.description":
        "为所有存储对象添加统一路径前缀，留空不添加。",
      "settings.forcePathStyle.label": "路径寻址",
      "settings.forcePathStyle.description":
        "使用端点/桶名形式访问，是否启用以服务商要求为准。",
      "settings.accessKeyId.label": "访问密钥 ID",
      "settings.secretAccessKey.label": "访问密钥",
      "settings.sessionToken.label": "会话令牌",
      "settings.redirect.label": "302 重定向",
      "settings.signedUrlSeconds.label": "签名链接有效期（秒）",
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
        "x-ui": {
          labelKey: "settings.multipartThresholdMiB.label",
          advanced: true,
        },
        type: "integer",

        minimum: 5,
        maximum: 5120,
        default: 64,
      },
      partSizeMiB: {
        "x-ui": { labelKey: "settings.partSizeMiB.label", advanced: true },
        type: "integer",

        minimum: 5,
        maximum: 512,
        default: 16,
      },
      partConcurrency: {
        "x-ui": { labelKey: "settings.partConcurrency.label", advanced: true },
        type: "integer",

        minimum: 1,
        maximum: 8,
        default: 3,
      },
      endpoint: {
        "x-ui": { labelKey: "settings.endpoint.label" },
        type: "string",

        format: "uri",
        "x-immutable": true,
      },
      region: {
        "x-ui": { labelKey: "settings.region.label" },
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
      bucket: {
        "x-ui": { labelKey: "settings.bucket.label" },
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
      keyPrefix: {
        "x-ui": {
          labelKey: "settings.keyPrefix.label",
          descriptionKey: "settings.keyPrefix.description",
          advanced: true,
        },
        type: "string",

        default: "",
        "x-immutable": true,
      },
      forcePathStyle: {
        "x-ui": {
          labelKey: "settings.forcePathStyle.label",
          descriptionKey: "settings.forcePathStyle.description",
        },
        type: "boolean",

        default: true,
        "x-immutable": true,
      },
      accessKeyId: {
        "x-ui": { labelKey: "settings.accessKeyId.label" },
        type: "string",

        minLength: 1,
        "x-sensitive": true,
      },
      secretAccessKey: {
        "x-ui": { labelKey: "settings.secretAccessKey.label" },
        type: "string",

        minLength: 1,
        "x-sensitive": true,
      },
      sessionToken: {
        "x-ui": { labelKey: "settings.sessionToken.label", advanced: true },
        type: "string",

        "x-sensitive": true,
      },
      redirect: {
        "x-ui": { labelKey: "settings.redirect.label" },
        type: "boolean",

        default: false,
      },
      signedUrlSeconds: {
        "x-ui": {
          labelKey: "settings.signedUrlSeconds.label",
          visibleWhen: { path: "/redirect", equals: true },
        },
        type: "integer",

        minimum: 1,
        maximum: 604800,
        default: 300,
      },
    },
    allOf: [
      {
        if: {
          properties: { redirect: { const: true } },
          required: ["redirect"],
        },
        then: { required: ["signedUrlSeconds"] },
      },
    ],
    required: [
      "region",
      "bucket",
      "accessKeyId",
      "secretAccessKey",
      "multipartThresholdMiB",
      "partSizeMiB",
      "partConcurrency",
    ],
    additionalProperties: false,
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
          if (size >= Number(config.multipartThresholdMiB) * 1024 ** 2) {
            await multipartWrite(
              client,
              {
                Bucket: bucket,
                Key: key(logical, null),
                ContentType: file.metadata.mimeType ?? undefined,
                Metadata: { operation: operationId, file: fileId },
              },
              file,
              Number(config.partSizeMiB) * 1024 ** 2,
              Number(config.partConcurrency),
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
