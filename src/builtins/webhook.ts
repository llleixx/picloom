import { PluginError, type Definition } from "../../plugin-sdk";
export const webhook: Definition<"processor"> = {
  id: "builtin.webhook",
  name: "Webhook",
  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    post_save: {
      translations: {
        "zh-CN": {
          configSchema: {
            "/properties/url": {
              title: "目标链接",
            },
            "/properties/token": {
              title: "Bearer 令牌",
            },
            "/properties/timeoutMs": {
              title: "超时时间（毫秒）",
            },
          },
        },
      },
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          url: { type: "string", title: "Target URL", format: "uri" },
          token: { type: "string", title: "Bearer Token", "x-sensitive": true },
          timeoutMs: {
            type: "integer",
            title: "Timeout (ms)",
            minimum: 100,
            maximum: 120000,
            default: 10000,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      async validateConfig(config) {
        try {
          const u = new URL(String(config.url));
          if (
            !["http:", "https:"].includes(u.protocol) ||
            u.username ||
            u.password
          )
            throw 0;
          return [];
        } catch {
          return [{ path: "/url", message: "Invalid HTTP URL" }];
        }
      },
      async createInstance({ config, services }) {
        return {
          async execute(input, ctx) {
            ctx.signal.throwIfAborted();
            if (!/^https?:\/\//.test(input.url))
              throw new PluginError(
                "INVALID_CONFIG",
                "Configure a site or image origin for background URL delivery.",
              );
            const secret = (await services.readSecrets()).value;
            const signal = AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout(Number(config.timeoutMs)),
            ]);
            let response: Response;
            try {
              response = await fetch(String(config.url), {
                method: "POST",
                redirect: "manual",
                signal,
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": input.operationId,
                  ...(secret.token
                    ? { authorization: "Bearer " + String(secret.token) }
                    : {}),
                },
                body: JSON.stringify({
                  event: "file.saved",
                  operationId: input.operationId,
                  fileId: input.fileId,
                  url: input.url,
                  mimeType: input.file.metadata.mimeType,
                  byteSize: input.file.metadata.byteSize,
                  width: input.file.metadata.width,
                  height: input.file.metadata.height,
                }),
              });
            } catch {
              throw new PluginError("NETWORK", "Webhook 网络错误或超时", true);
            }
            await response.body?.cancel();
            if (!response.ok)
              throw new PluginError(
                response.status === 429 ? "RATE_LIMITED" : "SERVICE",
                "Webhook 返回失败状态",
                response.status === 429 || response.status >= 500,
                "notApplied",
              );
            return { status: "pass" };
          },
        };
      },
    },
  },
};
