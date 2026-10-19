import { isPluginError } from "../../../../plugin-sdk/api";
import { PluginError, type Definition, type Locator } from "../../../../plugin-sdk";

// Hosted Bot API permits larger uploads, but getFile only downloads up to 20 MB.
const maxBytes = 20_000_000;
const origin = "https://api.telegram.org";
type TelegramLocator = {
  fileId: string;
  chatId: string;
  messageId: number;
  byteSize: number;
  mimeType: string;
};
function stored(locator: Locator): TelegramLocator {
  if (
    !locator ||
    typeof locator !== "object" ||
    typeof locator.fileId !== "string" ||
    !/^[\w-]+$/.test(locator.fileId) ||
    typeof locator.chatId !== "string" ||
    !/^-?\d+$/.test(locator.chatId) ||
    !Number.isSafeInteger(locator.messageId) ||
    Number(locator.messageId) <= 0 ||
    !Number.isSafeInteger(locator.byteSize) ||
    Number(locator.byteSize) < 0 ||
    typeof locator.mimeType !== "string"
  )
    throw new PluginError(
      "INVALID_INPUT",
      "Invalid Telegram locator",
      false,
      "notApplied",
    );
  return locator as TelegramLocator;
}
export const telegramStorage: Definition<"storage"> = {
  id: "builtin.telegram",
  name: "Telegram",
  description:
    "Store originals as bot documents (20 MB limit). Non-deletable messages finish local cleanup but may remain on Telegram.",
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      botToken: {
        type: "string",
        title: "Bot token",
        minLength: 1,
        "x-sensitive": true,
      },
      chatId: {
        type: "string",
        title: "Chat ID",
        description:
          "Numeric chat ID. Files are limited to 20,000,000 bytes so the hosted API can download them. Deletion needs permissions and a message age below 48 hours.",
        pattern: "^-?[0-9]+$",
        "x-immutable": true,
      },
      timeoutMs: {
        type: "integer",
        title: "Timeout (ms)",
        minimum: 100,
        maximum: 120000,
        default: 30000,
      },
    },
    required: ["botToken", "chatId"],
    additionalProperties: false,
  },
  uiHints: { "/timeoutMs": { advanced: true } },
  translations: {
    "zh-CN": {
      name: "Telegram",
      description:
        "以机器人文档保存原文件（上限 20 MB）。消息无法删除时仅完成本地清理，Telegram 消息可能保留。",
      configSchema: {
        "/properties/botToken": { title: "机器人令牌" },
        "/properties/chatId": {
          title: "聊天 ID",
          description:
            "填写数字聊天 ID。单文件最多 20,000,000 字节，以保证官方 API 可下载。删除需相应权限，且消息不超过 48 小时。",
        },
        "/properties/timeoutMs": { title: "超时（毫秒）" },
      },
    },
  },
  async createInstance({ config, services }) {
    const signalFor = (signal: AbortSignal) =>
      AbortSignal.any([
        signal,
        AbortSignal.timeout(Number(config.timeoutMs ?? 30000)),
      ]);
    async function token() {
      const value = (await services.readSecrets()).value.botToken;
      if (typeof value !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(value))
        throw new PluginError(
          "ACCESS_DENIED",
          "Invalid Telegram bot token",
          false,
          "notApplied",
        );
      return value;
    }
    async function api(
      method: string,
      body: BodyInit,
      signal: AbortSignal,
      credential?: string,
    ): Promise<any> {
      const writing = method === "sendDocument";
      const secret = credential ?? (await token());
      try {
        const response = await fetch(`${origin}/bot${secret}/${method}`, {
          method: "POST",
          body,
          redirect: "error",
          signal,
        });
        const data = await response.json().catch(() => null);
        // Missing messages and explicit platform deletion restrictions finish local cleanup.
        // A non-deletable message may still exist remotely (e.g. beyond 48 hours).
        if (
          method === "deleteMessage" &&
          response.status === 400 &&
          data?.ok === false &&
          data.error_code === 400 &&
          (data.description === "Bad Request: message to delete not found" ||
            data.description === "Bad Request: message can't be deleted")
        )
          return true;
        if (data?.ok === false && Number.isInteger(data.error_code)) {
          const status = data.error_code;
          throw new PluginError(
            status === 401 || status === 403
              ? "ACCESS_DENIED"
              : status === 429
                ? "RATE_LIMITED"
                : "SERVICE",
            "Telegram rejected the request",
            status === 429 || (!writing && status >= 500),
            status >= 400 && status < 500 ? "notApplied" : "unknown",
          );
        }
        if (!response.ok || data?.ok !== true || data.result === undefined)
          throw new PluginError(
            "INVALID_DATA",
            "Unconfirmed Telegram response",
            !writing,
            "unknown",
          );
        return data.result;
      } catch (error) {
        if (isPluginError(error)) throw error;
        // fetch errors may contain the token-bearing URL. Never forward their text/cause.
        throw new PluginError(
          "NETWORK",
          "Telegram request outcome is unknown",
          !writing,
          "unknown",
        );
      }
    }
    async function info(
      locator: TelegramLocator,
      signal: AbortSignal,
      credential?: string,
    ) {
      const result = await api(
        "getFile",
        new URLSearchParams({ file_id: locator.fileId }),
        signal,
        credential,
      );
      if (
        result.file_id !== locator.fileId ||
        !Number.isSafeInteger(result.file_size) ||
        typeof result.file_path !== "string" ||
        !/^[A-Za-z0-9_./-]+$/.test(result.file_path) ||
        result.file_path
          .split("/")
          .some((part: string) => !part || part === "." || part === "..")
      )
        throw new PluginError("INVALID_DATA", "Invalid Telegram file metadata");
      return result as { file_size: number; file_path: string };
    }
    return {
      async write({ fileId, storageKey, file }, ctx) {
        ctx.signal.throwIfAborted();
        const size = file.metadata.byteSize;
        if (
          size === null ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > maxBytes
        )
          throw new PluginError(
            "RESOURCE_LIMIT",
            "Telegram requires a known size of at most 20,000,000 bytes",
            false,
            "notApplied",
          );
        const signal = signalFor(ctx.signal);
        const reader = (await file.openRead()).getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let length = 0;
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
            length += value.byteLength;
            if (length > size || length > maxBytes) throw new Error();
            chunks.push(new Uint8Array(value));
          }
          if (length !== size) throw new Error();
        } catch {
          throw new PluginError(
            "RESOURCE_LIMIT",
            "Could not prepare Telegram upload with the declared size",
            false,
            "notApplied",
          );
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const mimeType = file.metadata.mimeType ?? "application/octet-stream";
        const extension = storageKey.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "";
        const form = new FormData();
        form.set("chat_id", String(config.chatId));
        form.set("disable_content_type_detection", "true");
        form.set(
          "document",
          new File(chunks, fileId + extension, { type: mimeType }),
        );
        const result = await api("sendDocument", form, signal);
        if (
          !Number.isSafeInteger(result.message_id) ||
          result.message_id <= 0 ||
          !Number.isSafeInteger(result.chat?.id) ||
          String(result.chat.id) !== String(config.chatId) ||
          typeof result.document?.file_id !== "string" ||
          !/^[\w-]+$/.test(result.document.file_id) ||
          result.document.file_size !== size
        )
          throw new PluginError(
            "INVALID_DATA",
            "Unconfirmed Telegram document upload",
            false,
            "unknown",
          );
        return {
          locator: {
            fileId: result.document.file_id,
            chatId: String(result.chat.id),
            messageId: result.message_id,
            byteSize: size,
            mimeType,
          },
        };
      },
      async read({ locator }, ctx) {
        ctx.signal.throwIfAborted();
        const value = stored(locator);
        const signal = signalFor(ctx.signal);
        const secret = await token();
        const result = await info(value, signal, secret);
        if (result.file_size !== value.byteSize)
          throw new PluginError(
            "INVALID_DATA",
            "Telegram file size differs from the stored locator",
          );
        try {
          // Both auto and forced-stream reads stay on the server: this URL contains a secret.
          const response = await fetch(
            `${origin}/file/bot${secret}/${result.file_path}`,
            { redirect: "error", signal },
          );
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new PluginError(
              "NETWORK",
              "Telegram download failed",
              response.status === 429 || response.status >= 500,
            );
          }
          const reader = response.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  controller.close();
                  reader.releaseLock();
                } else controller.enqueue(chunk.value);
              } catch {
                // Body errors can also include the credential-bearing upstream URL.
                controller.error(
                  new PluginError(
                    "NETWORK",
                    "Telegram download stream failed",
                    true,
                  ),
                );
                reader.releaseLock();
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            },
          });
          return {
            type: "stream",
            stream,
            mimeType: value.mimeType,
            byteSize: result.file_size,
          };
        } catch (error) {
          if (isPluginError(error)) throw error;
          throw new PluginError("NETWORK", "Telegram download failed", true);
        }
      },
      async delete({ locator }, ctx) {
        ctx.signal.throwIfAborted();
        const value = stored(locator);
        let result: unknown;
        try {
          result = await api(
            "deleteMessage",
            new URLSearchParams({
              chat_id: value.chatId,
              message_id: String(value.messageId),
            }),
            signalFor(ctx.signal),
          );
        } catch (error) {
          if (
            isPluginError(error) &&
            error.code === "SERVICE" &&
            error.outcome === "notApplied"
          )
            throw new PluginError(
              "UNSUPPORTED",
              "Telegram refused message deletion; check the 48-hour limit, message existence and bot permissions",
              false,
              "notApplied",
            );
          throw error;
        }
        if (result !== true)
          throw new PluginError(
            "SERVICE",
            "Telegram did not confirm message deletion",
            true,
            "unknown",
          );
      },
    };
  },
};
