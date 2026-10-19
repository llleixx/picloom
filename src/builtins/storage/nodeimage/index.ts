import { isPluginError } from "../../../../plugin-sdk/api";
import { PluginError, type Definition, type Locator } from "../../../../plugin-sdk";

const apiOrigin = "https://api.nodeimage.com";
function locatorId(storageKey: string, locator: Locator): string {
  const id =
    locator === null
      ? storageKey
      : typeof locator === "object"
        ? locator.imageId
        : undefined;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw new PluginError(
      "INVALID_INPUT",
      "Invalid NodeImage image ID",
      false,
      "notApplied",
    );
  return id;
}
function imageUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new PluginError("INVALID_DATA", "Missing NodeImage image URL");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw 0;
    return url.href;
  } catch {
    throw new PluginError("INVALID_DATA", "Invalid NodeImage image URL");
  }
}
export const nodeImageStorage: Definition<"storage"> = {
  id: "builtin.nodeimage",
  name: "NodeImage",
  description:
    "Store images on NodeImage. Unsupported API deletion completes local cleanup; remote images may remain.",
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        title: "API key",
        minLength: 1,
        "x-sensitive": true,
      },
      redirect: {
        type: "boolean",
        title: "Redirect reads (302)",
        default: true,
      },
      timeoutMs: {
        type: "integer",
        title: "Timeout (ms)",
        minimum: 100,
        maximum: 120000,
        default: 30000,
      },
    },
    required: ["apiKey"],
    additionalProperties: false,
  },
  uiHints: { "/timeoutMs": { advanced: true } },
  translations: {
    "zh-CN": {
      name: "NodeImage",
      description:
        "使用 NodeImage 存储图片。API 不支持删除时仅完成本地清理，远端图片可能保留。",
      configSchema: {
        "/properties/apiKey": { title: "API 密钥" },
        "/properties/redirect": { title: "302 重定向" },
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
    async function request(
      path: string,
      init: RequestInit,
      signal: AbortSignal,
    ) {
      const secrets = (await services.readSecrets()).value;
      return fetch(apiOrigin + path, {
        ...init,
        redirect: "error",
        signal,
        headers: { "X-API-Key": String(secrets.apiKey) },
      });
    }
    async function info(id: string, signal: AbortSignal) {
      const response = await request(
        "/api/image/" + encodeURIComponent(id),
        {},
        signal,
      );
      const value = await response.json().catch(() => null);
      if (response.status === 404 && value?.error === "Image not found")
        return null;
      if (!response.ok) throw httpError(response.status);
      if (value?.image_id !== id || typeof value?.size !== "number")
        throw new PluginError(
          "INVALID_DATA",
          "Invalid NodeImage image metadata",
        );
      return {
        imageId: id,
        url: imageUrl(value.links?.direct),
        size: value.size,
      };
    }
    function httpError(status: number, writing = false) {
      return new PluginError(
        status === 401 || status === 403
          ? "ACCESS_DENIED"
          : status === 429
            ? "RATE_LIMITED"
            : "SERVICE",
        "NodeImage rejected the request",
        status === 429 || status >= 500,
        writing && status >= 500 ? "unknown" : "notApplied",
      );
    }
    return {
      async write({ fileId, storageKey, file }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        // NodeImage accepts multipart, not a user-selected object key.
        const stream = await file.openRead();
        const reader = stream.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
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
            chunks.push(new Uint8Array(value));
          }
        } catch {
          throw new PluginError(
            "FAILED",
            "Could not prepare NodeImage upload",
            true,
            "notApplied",
          );
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel();
          reader.releaseLock();
        }
        const extension = storageKey.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "";
        const form = new FormData();
        form.set(
          "image",
          new File(chunks, fileId + extension, {
            type: file.metadata.mimeType ?? "application/octet-stream",
          }),
        );
        try {
          const response = await request(
            "/api/upload",
            { method: "POST", body: form },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status, true);
          }
          const data = await response.json();
          if (
            data?.success !== true ||
            typeof data.image_id !== "string" ||
            !/^[a-zA-Z0-9_-]+$/.test(data.image_id)
          )
            throw new PluginError(
              "INVALID_DATA",
              "Invalid NodeImage upload result",
              false,
              "unknown",
            );
          return {
            locator: {
              imageId: data.image_id,
              url: imageUrl(data.links?.direct),
            },
          };
        } catch (error) {
          if (isPluginError(error)) throw error;
          // No idempotency key or lookup by operation ID: retry could create a duplicate.
          throw new PluginError(
            "FAILED",
            "NodeImage upload outcome is unknown",
            false,
            "unknown",
          );
        }
      },
      async read({ storageKey, locator, mode }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        const id = locatorId(storageKey, locator);
        const url =
          locator && typeof locator === "object" && locator.url
            ? imageUrl(locator.url)
            : (await info(id, signal))?.url;
        if (!url)
          throw new PluginError("NOT_FOUND", "NodeImage image not found");
        if (mode === "auto" && config.redirect !== false)
          return { type: "redirect", url };
        const response = await fetch(url, { signal }); // Never send API credentials to the CDN.
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new PluginError(
            "SERVICE",
            "NodeImage download failed",
            response.status >= 500,
          );
        }
        const length = response.headers.get("content-length");
        return {
          type: "stream",
          stream: response.body,
          mimeType: response.headers.get("content-type") ?? undefined,
          byteSize:
            length !== null && /^\d+$/.test(length)
              ? Number(length)
              : undefined,
        };
      },
      async delete({ storageKey, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        const id = locatorId(storageKey, locator);
        const response = await request(
          "/api/image/" + encodeURIComponent(id),
          { method: "DELETE" },
          signal,
        );
        // The provider may not expose deletion. Finish local cleanup even if the image remains.
        if ([404, 405, 501].includes(response.status)) {
          await response.body?.cancel();
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw httpError(response.status, true);
        }
        const result =
          response.status === 204
            ? null
            : await response.json().catch(() => null);
        if (response.status !== 204 && result?.success !== true)
          throw new PluginError(
            "INVALID_DATA",
            "Unconfirmed NodeImage deletion",
            false,
            "unknown",
          );
        await response.body?.cancel();
      },
      async recoverWrite({ storageKey, locator, expectedSize }, ctx) {
        ctx.signal.throwIfAborted();
        if (locator === null) return { status: "unknown" };
        try {
          const found = await info(
            locatorId(storageKey, locator),
            signalFor(ctx.signal),
          );
          // A deleted image does not prove the original POST was never applied.
          return found && found.size === expectedSize
            ? {
                status: "stored",
                locator: { imageId: found.imageId, url: found.url },
              }
            : { status: "unknown" };
        } catch {
          return { status: "unknown" };
        }
      },
    };
  },
};
