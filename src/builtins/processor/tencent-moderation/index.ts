import { isPluginError } from "../../../../plugin-sdk/api";
import { createHash, createHmac } from "node:crypto";
import {
  PluginError,
  type Config,
  type Definition,
  type FileInput,
} from "../../../../plugin-sdk";

const endpoint = "https://ims.tencentcloudapi.com";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

/** TC3 signing for this single API; no generic cloud client or internal retries. */
function headers(
  body: string,
  region: string,
  secretId: string,
  secretKey: string,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/ims/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:ims.tencentcloudapi.com\n\ncontent-type;host\n${sha256(body)}`;
  const signingKey = hmac(
    hmac(hmac("TC3" + secretKey, date), "ims"),
    "tc3_request",
  );
  const signature = hmac(
    signingKey,
    `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`,
  ).toString("hex");
  return {
    "content-type": "application/json",
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    "x-tc-action": "ImageModeration",
    "x-tc-version": "2020-12-29",
    "x-tc-region": region,
    "x-tc-timestamp": String(timestamp),
  };
}
async function content(file: FileInput, signal: AbortSignal, limit: number) {
  const tooLarge = () =>
    new PluginError(
      "RESOURCE_LIMIT",
      "Image exceeds the configured content submission limit",
      false,
      "notApplied",
    );
  if (file.metadata.byteSize !== null && file.metadata.byteSize > limit)
    throw tooLarge();
  const stream = await file.openRead();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("base64");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel();
    reader.releaseLock();
  }
}
function apiError(code: string): PluginError {
  if (code === "ResourceUnavailable.ImageDownloadError")
    return new PluginError(
      "SERVICE",
      "Tencent Cloud could not download the image. Check that its public URL is reachable.",
    );
  if (code.startsWith("RequestLimitExceeded"))
    return new PluginError("RATE_LIMITED", "Request rate exceeded", true);
  if (/^(ResourceInsufficient|LimitExceeded)/.test(code))
    return new PluginError("RESOURCE_LIMIT", "Service quota exceeded");
  if (code.startsWith("UnsupportedOperation"))
    return new PluginError("UNSUPPORTED", "Operation is unsupported");
  if (/^(AuthFailure|UnauthorizedOperation|OperationDenied)/.test(code))
    return new PluginError(
      "ACCESS_DENIED",
      "Check Tencent Cloud credentials, permissions and service quota",
    );
  if (
    /^(InvalidParameter|MissingParameter|UnknownParameter)/.test(code) ||
    code.endsWith("InvalidImageContent")
  )
    return new PluginError(
      "INVALID_INPUT",
      "Tencent Cloud rejected the image or request parameters",
    );
  return new PluginError(
    "SERVICE",
    "Tencent Cloud moderation failed",
    /^(InternalError|RequestLimitExceeded)/.test(code) ||
      code === "ResourceUnavailable.ModelCallFailed",
  );
}

export const tencentModeration: Definition<"processor"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "Tencent Cloud Moderation",
      "package.description":
        "Review images using a Tencent Cloud content safety policy.",
      "settings.secretId.label": "Secret ID",
      "settings.secretKey.label": "Secret key",
      "settings.region.label": "Region",
      "settings.bizType.label": "BizType",
      "settings.bizType.description":
        "Policy ID from the Tencent Cloud console.",
      "settings.submissionMode.label": "Submission method",
      "settings.submissionMode.description":
        "URL mode uses the public image URL. It must be accessible to Tencent Cloud; hotlink protection or redirects may prevent access.",
      "settings.submissionMode.options.content": "File content",
      "settings.submissionMode.options.url": "Public URL",
      "settings.maxContentMiB.label": "Content size limit (MiB)",
      "settings.maxContentMiB.description":
        "File content mode only. Oversized files fail without retry; this does not change the provider's limits.",
      "settings.blockAction.label": "On violation",
      "settings.blockAction.description":
        "Review results always block access for manual review.",
      "settings.blockAction.options.block": "block",
      "settings.blockAction.options.delete": "delete",
      "settings.timeoutMs.label": "Timeout (ms)",
      "settings.interval.label": "GIF frame interval",
      "settings.maxFrames.label": "Maximum GIF frames",
      "settings.maxFrames.description":
        "Sampled frames only; additional frames may increase usage.",
    },
    "zh-CN": {
      "package.name": "腾讯云内容审核",
      "package.description": "使用腾讯云内容安全策略审核图片。",
      "settings.secretId.label": "密钥 ID",
      "settings.secretKey.label": "密钥",
      "settings.region.label": "地域",
      "settings.bizType.label": "BizType",
      "settings.bizType.description": "腾讯云控制台中的策略标识。",
      "settings.submissionMode.label": "送审方式",
      "settings.submissionMode.description":
        "URL 模式使用图片公开链接。腾讯云须能访问；防盗链或重定向可能导致下载失败。",
      "settings.submissionMode.options.content": "文件内容",
      "settings.submissionMode.options.url": "公开 URL",
      "settings.maxContentMiB.label": "内容大小上限（MiB）",
      "settings.maxContentMiB.description":
        "仅限文件内容模式；超限失败且不重试，不改变服务商自身限制。",
      "settings.blockAction.label": "违规处置",
      "settings.blockAction.description": "疑似结果始终阻止访问，供人工复核。",
      "settings.blockAction.options.block": "阻止访问",
      "settings.blockAction.options.delete": "删除",
      "settings.timeoutMs.label": "超时（毫秒）",
      "settings.interval.label": "GIF 抽帧间隔",
      "settings.maxFrames.label": "GIF 最大抽帧数",
      "settings.maxFrames.description": "只审核抽样帧；增加帧数可能增加用量。",
    },
  },

  id: "builtin.tencent-moderation",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    post_save: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          secretId: {
            "x-ui": { labelKey: "settings.secretId.label" },
            type: "string",

            minLength: 1,
            "x-sensitive": true,
          },
          secretKey: {
            "x-ui": { labelKey: "settings.secretKey.label" },
            type: "string",

            minLength: 1,
            "x-sensitive": true,
          },
          region: {
            "x-ui": { labelKey: "settings.region.label", advanced: true },
            type: "string",

            minLength: 1,
            default: "ap-guangzhou",
          },
          bizType: {
            "x-ui": {
              labelKey: "settings.bizType.label",
              descriptionKey: "settings.bizType.description",
            },
            type: "string",

            minLength: 1,
          },
          submissionMode: {
            "x-ui": {
              labelKey: "settings.submissionMode.label",
              descriptionKey: "settings.submissionMode.description",
              enumKeys: [
                "settings.submissionMode.options.content",
                "settings.submissionMode.options.url",
              ],
            },
            type: "string",

            enum: ["content", "url"],
            default: "content",
          },
          maxContentMiB: {
            "x-ui": {
              labelKey: "settings.maxContentMiB.label",
              descriptionKey: "settings.maxContentMiB.description",
            },
            type: "integer",

            minimum: 1,
            maximum: 20,
            default: 5,
          },
          blockAction: {
            "x-ui": {
              labelKey: "settings.blockAction.label",
              descriptionKey: "settings.blockAction.description",
              enumKeys: [
                "settings.blockAction.options.block",
                "settings.blockAction.options.delete",
              ],
            },
            type: "string",

            enum: ["block", "delete"],
            default: "block",
          },
          timeoutMs: {
            "x-ui": { labelKey: "settings.timeoutMs.label", advanced: true },
            type: "integer",

            minimum: 100,
            maximum: 120000,
            default: 30000,
          },
          interval: {
            "x-ui": { labelKey: "settings.interval.label", advanced: true },
            type: "integer",

            minimum: 1,
            maximum: 1000,
            default: 5,
          },
          maxFrames: {
            "x-ui": {
              labelKey: "settings.maxFrames.label",
              descriptionKey: "settings.maxFrames.description",
              advanced: true,
            },
            type: "integer",

            minimum: 1,
            maximum: 400,
            default: 5,
          },
        },
        required: [
          "secretId",
          "secretKey",
          "region",
          "bizType",
          "blockAction",
          "submissionMode",
          "timeoutMs",
          "interval",
          "maxFrames",
          "maxContentMiB",
        ],
        additionalProperties: false,
      },

      async createInstance({ config, services }) {
        return {
          async execute(input, ctx) {
            ctx.signal.throwIfAborted();
            if (
              config.submissionMode === "url" &&
              !/^https?:\/\//.test(input.url)
            )
              throw new PluginError(
                "INVALID_CONFIG",
                "Configure a site or image origin for background URL delivery.",
              );
            const secrets = (await services.readSecrets()).value;
            const signal = AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout(Number(config.timeoutMs)),
            ]);
            let payload: any;
            try {
              signal.throwIfAborted();
              const body = JSON.stringify({
                BizType: config.bizType,
                DataId: input.fileId,
                ...(config.submissionMode === "url"
                  ? { FileUrl: input.url }
                  : {
                      FileContent: await content(
                        input.file,
                        signal,
                        Number(config.maxContentMiB) * 1024 ** 2,
                      ),
                    }),
                Type: "IMAGE",
                Interval: config.interval,
                MaxFrames: config.maxFrames,
              });
              const response = await fetch(endpoint, {
                method: "POST",
                redirect: "error",
                signal,
                headers: headers(
                  body,
                  String(config.region),
                  String(secrets.secretId),
                  String(secrets.secretKey),
                ),
                body,
              });
              if (!response.ok) {
                await response.body?.cancel();
                throw new PluginError(
                  "SERVICE",
                  "Tencent Cloud returned an HTTP error",
                  response.status === 429 || response.status >= 500,
                );
              }
              try {
                payload = await response.json();
              } catch (error) {
                signal.throwIfAborted();
                throw new PluginError(
                  "INVALID_DATA",
                  "Invalid Tencent Cloud response",
                );
              }
            } catch (error) {
              ctx.signal.throwIfAborted();
              if (isPluginError(error)) throw error;
              throw new PluginError(
                "NETWORK",
                "Tencent Cloud request failed or timed out",
                true,
              );
            }
            const result = payload?.Response;
            if (result?.Error) throw apiError(String(result.Error.Code));
            if (
              !result ||
              !["Pass", "Review", "Block"].includes(result.Suggestion)
            )
              throw new PluginError(
                "INVALID_DATA",
                "Missing or unknown Tencent Cloud suggestion",
              );
            const details: Config = { suggestion: result.Suggestion };
            for (const [source, target] of [
              ["Label", "label"],
              ["SubLabel", "subLabel"],
              ["RequestId", "requestId"],
            ] as const)
              if (typeof result[source] === "string")
                details[target] = result[source];
            if (
              typeof result.Score === "number" &&
              Number.isFinite(result.Score)
            )
              details.score = result.Score;
            // Keep per-category summaries, never raw OCR text, coordinates or full responses.
            if (Array.isArray(result.LabelResults))
              details.labels = result.LabelResults.map((item: any) => {
                const label: Config = {};
                for (const key of ["Scene", "Label", "SubLabel", "Suggestion"])
                  if (typeof item?.[key] === "string") label[key] = item[key];
                if (
                  typeof item?.Score === "number" &&
                  Number.isFinite(item.Score)
                )
                  label.Score = item.Score;
                return label;
              });
            return {
              status:
                result.Suggestion === "Pass"
                  ? "pass"
                  : result.Suggestion === "Review"
                    ? "block"
                    : (config.blockAction as "block" | "delete"),
              details,
            };
          },
        };
      },
    },
  },
};
