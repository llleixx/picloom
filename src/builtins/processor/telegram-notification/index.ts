import {
  isPluginError,
  PluginError,
  type Definition,
  type PostSaveResult,
} from "@picloom/plugin-sdk";

export const telegramNotification: Definition<"processor"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "Telegram Notification",
      "package.description":
        "Send a text notification for selected accumulated pipeline statuses.",
      "settings.botToken.label": "Bot token",
      "settings.chatId.label": "Chat ID",
      "settings.chatId.description":
        "Numeric ID of a chat where the bot can send messages.",
      "settings.statuses.label": "Notify on statuses",
      "settings.statuses.description":
        "Matches the accumulated status when this step runs. Place this step last.",
      "settings.includeDetails.label": "Include previous step details",
      "settings.includeDetails.description":
        "Send previous plugins' details to this chat. Long messages are truncated.",
      "settings.timeoutMs.label": "Timeout (ms)",
    },
    "zh-CN": {
      "package.name": "Telegram 通知",
      "package.description": "按流水线当前累计状态发送文字通知。",
      "settings.botToken.label": "机器人令牌",
      "settings.chatId.label": "聊天 ID",
      "settings.chatId.description":
        "填写数字聊天 ID，机器人需有发送消息的权限。",
      "settings.statuses.label": "通知状态",
      "settings.statuses.description":
        "匹配执行到此步骤时的累计状态，建议将此步骤放在最后。",
      "settings.includeDetails.label": "附带前序步骤详情",
      "settings.includeDetails.description":
        "将前序插件的 details 发送到此聊天，消息过长时截断。",
      "settings.timeoutMs.label": "超时（毫秒）",
    },
  },

  id: "builtin.telegram-notification",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    post_save: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          botToken: {
            "x-ui": { labelKey: "settings.botToken.label" },
            type: "string",

            minLength: 1,
            "x-sensitive": true,
          },
          chatId: {
            "x-ui": {
              labelKey: "settings.chatId.label",
              descriptionKey: "settings.chatId.description",
            },
            type: "string",

            pattern: "^-?[0-9]+$",
          },
          statuses: {
            "x-ui": {
              labelKey: "settings.statuses.label",
              descriptionKey: "settings.statuses.description",
            },
            type: "array",

            uniqueItems: true,
            minItems: 1,
            maxItems: 3,
            items: { type: "string", enum: ["pass", "block", "delete"] },
            default: ["block", "delete"],
          },
          includeDetails: {
            "x-ui": {
              labelKey: "settings.includeDetails.label",
              descriptionKey: "settings.includeDetails.description",
            },
            type: "boolean",

            default: false,
          },
          timeoutMs: {
            "x-ui": { labelKey: "settings.timeoutMs.label", advanced: true },
            type: "integer",

            minimum: 100,
            maximum: 120000,
            default: 10000,
          },
        },
        required: [
          "botToken",
          "chatId",
          "statuses",
          "includeDetails",
          "timeoutMs",
        ],
        additionalProperties: false,
      },

      async createInstance({ config, services }) {
        return {
          async execute(input, ctx): Promise<PostSaveResult> {
            ctx.signal.throwIfAborted();
            if (!(config.statuses as string[]).includes(input.currentStatus))
              return { status: "pass", details: { sent: false } };
            const token = (await services.readSecrets()).value.botToken;
            if (
              typeof token !== "string" ||
              !/^\d+:[A-Za-z0-9_-]+$/.test(token)
            )
              throw new PluginError(
                "INVALID_CONFIG",
                "Invalid Telegram bot token",
                false,
                "notApplied",
              );
            const lines = [
              "Picloom",
              `Current status: ${input.currentStatus}`,
              `File: ${input.fileId}`,
              `URL: ${input.url}`,
            ];
            if (config.includeDetails) {
              for (const result of input.previousResults) {
                if (result.details === undefined) continue;
                lines.push(
                  "",
                  `${result.pluginId} [${result.stepId}] — ${result.status}`,
                  JSON.stringify(result.details, null, 2),
                );
              }
            }
            let text = lines.join("\n");
            // Stay below Telegram's 4096-character limit without splitting a surrogate pair.
            if (text.length > 4096)
              text =
                text.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "") +
                "\n… (truncated)";
            const signal = AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout(Number(config.timeoutMs)),
            ]);
            try {
              const response = await fetch(
                `https://api.telegram.org/bot${token}/sendMessage`,
                {
                  method: "POST",
                  redirect: "error",
                  signal,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    chat_id: config.chatId,
                    text,
                    link_preview_options: { is_disabled: true },
                  }),
                },
              );
              const data = await response.json().catch(() => null);
              if (!response.ok || data?.ok === false) {
                const code = Number.isInteger(data?.error_code)
                  ? data.error_code
                  : response.status;
                throw new PluginError(
                  code === 401 || code === 403
                    ? "ACCESS_DENIED"
                    : code === 429
                      ? "RATE_LIMITED"
                      : "SERVICE",
                  "Telegram rejected the notification",
                  code === 429,
                  code >= 400 && code < 500 ? "notApplied" : "unknown",
                );
              }
              if (
                data?.ok !== true ||
                !Number.isSafeInteger(data.result?.message_id) ||
                data.result.message_id <= 0
              )
                throw new PluginError(
                  "INVALID_DATA",
                  "Unconfirmed Telegram notification",
                  false,
                  "unknown",
                );
              return {
                status: "pass",
                details: { sent: true, messageId: data.result.message_id },
              };
            } catch (error) {
              ctx.signal.throwIfAborted();
              if (isPluginError(error)) throw error;
              // Telegram's URL contains the token. Do not expose fetch errors or causes.
              // A lost response may already have delivered the message; do not replay it.
              throw new PluginError(
                "NETWORK",
                "Telegram notification outcome is unknown",
                false,
                "unknown",
              );
            }
          },
        };
      },
    },
  },
};
