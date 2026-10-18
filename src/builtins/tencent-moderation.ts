import { isPluginError } from "../../plugin-sdk/api";
import { createHash, createHmac } from "node:crypto";
import {
  PluginError,
  type Config,
  type Definition,
  type FileInput,
} from "../../plugin-sdk";

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
  id: "builtin.tencent-moderation",
  name: "Tencent Cloud Moderation",
  description: "Review images using a Tencent Cloud content safety policy.",
  translations: {
    "zh-CN": {
      name: "腾讯云内容审核",
      description: "使用腾讯云内容安全策略审核图片。",
    },
  },
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
            type: "string",
            title: "Secret ID",
            minLength: 1,
            "x-sensitive": true,
          },
          secretKey: {
            type: "string",
            title: "Secret key",
            minLength: 1,
            "x-sensitive": true,
          },
          region: {
            type: "string",
            title: "Region",
            minLength: 1,
            default: "ap-guangzhou",
          },
          bizType: {
            type: "string",
            title: "BizType",
            minLength: 1,
            description: "Policy ID from the Tencent Cloud console.",
          },
          submissionMode: {
            type: "string",
            title: "Submission method",
            enum: ["content", "url"],
            default: "content",
            description:
              "URL mode uses the public image URL. It must be accessible to Tencent Cloud; hotlink protection or redirects may prevent access.",
          },
          maxContentMiB: {
            type: "integer",
            title: "Content size limit (MiB)",
            minimum: 1,
            maximum: 20,
            default: 5,
            description:
              "File content mode only. Oversized files fail without retry; this does not change the provider's limits.",
          },
          blockAction: {
            type: "string",
            title: "On violation",
            enum: ["block", "delete"],
            default: "block",
            description:
              "Review results always block access for manual review.",
          },
          timeoutMs: {
            type: "integer",
            title: "Timeout (ms)",
            minimum: 100,
            maximum: 120000,
            default: 30000,
          },
          interval: {
            type: "integer",
            title: "GIF frame interval",
            minimum: 1,
            maximum: 1000,
            default: 5,
          },
          maxFrames: {
            type: "integer",
            title: "Maximum GIF frames",
            minimum: 1,
            maximum: 400,
            default: 5,
            description:
              "Sampled frames only; additional frames may increase usage.",
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
        ],
        additionalProperties: false,
      },
      uiHints: {
        "/region": { advanced: true },
        "/timeoutMs": { advanced: true },
        "/interval": { advanced: true },
        "/maxFrames": { advanced: true },
      },
      translations: {
        en: {
          configSchema: {
            "/properties/submissionMode": {
              enumLabels: ["File content", "Public URL"],
            },
          },
        },
        "zh-CN": {
          configSchema: {
            "/properties/secretId": { title: "密钥 ID" },
            "/properties/secretKey": { title: "密钥" },
            "/properties/region": { title: "地域" },
            "/properties/bizType": {
              title: "BizType",
              description: "腾讯云控制台中的策略标识。",
            },
            "/properties/submissionMode": {
              title: "送审方式",
              enumLabels: ["文件内容", "公开 URL"],
              description:
                "URL 模式使用图片公开链接。腾讯云须能访问；防盗链或重定向可能导致下载失败。",
            },
            "/properties/maxContentMiB": {
              title: "内容大小上限（MiB）",
              description:
                "仅限文件内容模式；超限失败且不重试，不改变服务商自身限制。",
            },
            "/properties/blockAction": {
              title: "违规处置",
              enumLabels: ["阻止访问", "删除"],
              description: "疑似结果始终阻止访问，供人工复核。",
            },
            "/properties/timeoutMs": { title: "超时（毫秒）" },
            "/properties/interval": { title: "GIF 抽帧间隔" },
            "/properties/maxFrames": {
              title: "GIF 最大抽帧数",
              description: "只审核抽样帧；增加帧数可能增加用量。",
            },
          },
        },
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
                        Number(config.maxContentMiB ?? 5) * 1024 ** 2,
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
