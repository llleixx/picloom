import { scanScope, decodeCursor, encodeCursor } from "../shared/enumeration";
import { readDirectory, type DirectoryEntry } from "./enumeration";
import { logicalKey as storageKey, retainStream } from "../../../../plugin-sdk";
import {
  PluginError,
  type Definition,
  type Locator,
} from "../../../../plugin-sdk";

function endpoint(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.split("/").some((part) => {
      const decoded = decodeURIComponent(part);
      return (
        /[\\/\x00-\x1f\x7f]/.test(decoded) ||
        decoded === "." ||
        decoded === ".."
      );
    })
  )
    throw new Error("Invalid WebDAV endpoint");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validKey(value: string) {
  try {
    return storageKey(value);
  } catch {
    throw new PluginError(
      "INVALID_INPUT",
      "Invalid WebDAV object path",
      false,
      "notApplied",
    );
  }
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => {});
}

function failure(
  operation: string,
  status: number,
  outcome: "notApplied" | "unknown" = "unknown",
) {
  return new PluginError(
    status === 401 || status === 403
      ? "ACCESS_DENIED"
      : status === 429
        ? "RATE_LIMITED"
        : status === 507
          ? "RESOURCE_LIMIT"
          : "SERVICE",
    "WebDAV " + operation + " failed (HTTP " + status + ")",
    [408, 409, 423, 425, 429].includes(status) || status >= 500,
    outcome,
  );
}

export const webdavStorage: Definition<"storage"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "WebDAV Storage",
      "package.description": "Authenticated WebDAV storage with streamed reads",
      "settings.endpoint.label": "WebDAV endpoint",
      "settings.endpoint.description":
        "Existing WebDAV root URL; use the final URL, redirects are refused",
      "settings.keyPrefix.label": "Directory Prefix",
      "settings.keyPrefix.description":
        "Directory relative to the WebDAV endpoint. Leave empty to use the endpoint directory. Do not URL-encode.",
      "settings.timeoutMs.label": "Timeout (ms)",
      "settings.username.label": "Username",
      "settings.password.label": "Password or app password",
    },
    "zh-CN": {
      "package.name": "WebDAV 存储",
      "package.description": "通过 WebDAV 认证存储并以流式方式读取文件",
      "settings.endpoint.label": "WebDAV 端点",
      "settings.endpoint.description":
        "已存在的 WebDAV 根目录 URL；使用服务最终地址，不跟随重定向",
      "settings.keyPrefix.label": "目录前缀",
      "settings.keyPrefix.description":
        "相对于 WebDAV 端点的目录；留空使用端点目录，不要进行 URL 编码",
      "settings.timeoutMs.label": "超时（毫秒）",
      "settings.username.label": "用户名",
      "settings.password.label": "密码或应用密码",
    },
  },

  id: "builtin.webdav",

  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,

  configSchema: {
    type: "object",
    properties: {
      endpoint: {
        "x-ui": {
          labelKey: "settings.endpoint.label",
          descriptionKey: "settings.endpoint.description",
        },
        type: "string",

        format: "uri",
        "x-immutable": true,
      },
      keyPrefix: {
        "x-ui": {
          labelKey: "settings.keyPrefix.label",
          descriptionKey: "settings.keyPrefix.description",
        },
        type: "string",

        default: "",
        "x-immutable": true,
      },
      timeoutMs: {
        "x-ui": { labelKey: "settings.timeoutMs.label", advanced: true },
        type: "integer",

        minimum: 100,
        maximum: 120000,
        default: 30000,
      },
      username: {
        "x-ui": { labelKey: "settings.username.label" },
        type: "string",

        minLength: 1,
        pattern: "^[^:\\u0000-\\u001f\\u007f]+$",
        "x-sensitive": true,
      },
      password: {
        "x-ui": { labelKey: "settings.password.label" },
        type: "string",

        minLength: 1,
        pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        "x-sensitive": true,
      },
    },
    required: ["endpoint", "username", "password", "timeoutMs"],
    additionalProperties: false,
  },
  async validateConfig(config) {
    const errors: Array<{ path: string; message: string }> = [];
    try {
      endpoint(String(config.endpoint));
    } catch {
      errors.push({ path: "/endpoint", message: "Invalid WebDAV endpoint" });
    }
    try {
      if (config.keyPrefix) storageKey(String(config.keyPrefix));
    } catch {
      errors.push({ path: "/keyPrefix", message: "Invalid directory prefix" });
    }
    return errors;
  },
  async createInstance({ config, services }) {
    const signalFor = (signal: AbortSignal) =>
      AbortSignal.any([signal, AbortSignal.timeout(Number(config.timeoutMs))]);
    const base = endpoint(String(config.endpoint));
    const prefix = config.keyPrefix
      ? validKey(String(config.keyPrefix)) + "/"
      : "";
    const secrets = (await services.readSecrets()).value;
    const authorization =
      "Basic " +
      Buffer.from(
        String(secrets.username) + ":" + String(secrets.password),
        "utf8",
      ).toString("base64");
    const key = (logical: string, locator: Locator) => {
      if (locator === null) return validKey(logical);
      if (typeof locator === "object" && typeof locator.key === "string")
        return validKey(locator.key);
      throw new PluginError(
        "INVALID_INPUT",
        "Invalid WebDAV locator",
        false,
        "notApplied",
      );
    };
    const objectUrl = (path: string) =>
      new URL(
        (prefix + validKey(path)).split("/").map(encodeURIComponent).join("/"),
        base,
      );
    const request = async (
      url: URL,
      method: string,
      signal: AbortSignal,
      headers?: HeadersInit,
      body?: ReadableStream<Uint8Array>,
    ) => {
      signal.throwIfAborted();
      const requestHeaders = new Headers(headers);
      requestHeaders.set("authorization", authorization);
      requestHeaders.set("accept-encoding", "identity");
      try {
        const init: RequestInit & { duplex: "half" } = {
          method,
          headers: requestHeaders,
          body,
          signal,
          redirect: "manual",
          // Required by runtimes that enforce streaming request bodies.
          duplex: "half",
        };
        return await fetch(url, init);
      } catch {
        throw new PluginError(
          "NETWORK",
          "WebDAV " + method + " request failed",
          true,
          method === "PUT" || method === "DELETE" ? "unknown" : "notApplied",
        );
      }
    };
    const ensureParents = async (path: string, signal: AbortSignal) => {
      const parts = (prefix + path).split("/");
      parts.pop();
      for (let i = 1; i <= parts.length; i++) {
        const url = new URL(
          parts.slice(0, i).map(encodeURIComponent).join("/") + "/",
          base,
        );
        const response = await request(url, "MKCOL", signal);
        const status = response.status;
        await discard(response);
        // RFC 4918: 405 means the resource already exists, possibly a file.
        // Do not claim it is a collection; the subsequent child request must succeed.
        if (![200, 201, 204, 405].includes(status))
          throw failure("MKCOL", status, "notApplied");
      }
    };
    return {
      async listFiles({ scope: inputScope, cursor, limit }, ctx) {
        const scope = scanScope(inputScope);
        type Frame = { directory: string; after: string };
        const stack = decodeCursor<Frame[]>(cursor, scope) ?? [
          { directory: scope, after: "" },
        ];
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 1000 ||
          !Array.isArray(stack) ||
          !stack.length ||
          stack.some(
            (frame) =>
              !frame ||
              typeof frame.directory !== "string" ||
              typeof frame.after !== "string" ||
              frame.after.includes("/") ||
              (scope &&
                frame.directory !== scope &&
                !frame.directory.startsWith(scope + "/")),
          )
        )
          throw new PluginError(
            "INVALID_INPUT",
            "Invalid scan cursor or limit",
          );
        for (const frame of stack) {
          if (frame.directory) validKey(frame.directory);
          if (frame.after) validKey(frame.after);
        }
        const rootUrl = new URL(
          prefix.split("/").map(encodeURIComponent).join("/"),
          base,
        );
        const pages = new Map<Frame, DirectoryEntry[]>();
        const items: Array<{
          storageKey: string;
          byteSize?: number;
          mimeType?: string;
        }> = [];
        let requests = 0;
        while (stack.length && items.length < limit) {
          ctx.signal.throwIfAborted();
          const frame = stack.at(-1)!;
          let entries = pages.get(frame);
          if (!entries) {
            if (requests++ >= 8) break;
            const url = frame.directory
              ? objectUrl(frame.directory)
              : new URL(rootUrl);
            if (!url.pathname.endsWith("/")) url.pathname += "/";
            const signal = signalFor(ctx.signal);
            const body = new Blob([
              '<propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getcontenttype/></prop></propfind>',
            ]).stream();
            const response = await request(
              url,
              "PROPFIND",
              signal,
              { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
              body,
            );
            if (response.status !== 207) {
              await discard(response);
              throw failure("PROPFIND", response.status, "notApplied");
            }
            entries = await readDirectory(response, url, signal);
            pages.set(frame, entries);
          }
          let descended = false;
          for (const entry of entries) {
            if (entry.name <= frame.after) continue;
            frame.after = entry.name;
            const path = validKey(
              frame.directory ? frame.directory + "/" + entry.name : entry.name,
            );
            if (entry.directory) {
              stack.push({ directory: path, after: "" });
              descended = true;
              break;
            }
            items.push({
              storageKey: path,
              byteSize: entry.byteSize,
              mimeType: entry.mimeType,
            });
            if (items.length >= limit) break;
          }
          if (!descended && items.length < limit) {
            stack.pop();
            pages.delete(frame);
          }
        }
        const nextCursor = stack.length ? encodeCursor(scope, stack) : null;
        if (nextCursor && nextCursor.length > 32768)
          throw new PluginError(
            "INVALID_INPUT",
            "Scan is too deep; choose a narrower scope",
          );
        return { items, nextCursor };
      },
      async write({ storageKey: logical, file }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        signal.throwIfAborted();
        const size = file.metadata.byteSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw new PluginError(
            "INVALID_INPUT",
            "WebDAV PUT requires a known file size",
            false,
            "notApplied",
          );
        const path = validKey(logical);
        await ensureParents(path, signal);
        signal.throwIfAborted();
        const reader = (await file.openRead()).getReader();
        let bytes = 0;
        let complete = false;
        const cancel = () => {
          void reader.cancel(signal.reason).catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              signal.throwIfAborted();
              const result = await reader.read();
              signal.throwIfAborted();
              if (result.done) {
                if (bytes !== size) throw new Error("Incomplete WebDAV input");
                complete = true;
                controller.close();
              } else {
                bytes += result.value.byteLength;
                if (bytes > size) throw new Error("Oversized WebDAV input");
                controller.enqueue(result.value);
              }
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => {});
          },
        });
        try {
          const response = await request(
            objectUrl(path),
            "PUT",
            signal,
            {
              "if-none-match": "*",
              "content-length": String(size),
              "content-type":
                file.metadata.mimeType ?? "application/octet-stream",
            },
            body,
          );
          const status = response.status;
          await discard(response);
          if (status === 412)
            throw new PluginError(
              "CONFLICT",
              "WebDAV object already exists",
              false,
              "notApplied",
            );
          if (![200, 201, 204].includes(status))
            throw failure(
              "PUT",
              status,
              status >= 400 && status < 500 ? "notApplied" : "unknown",
            );
          if (!complete)
            throw new PluginError(
              "INVALID_DATA",
              "WebDAV server accepted an incomplete request",
              false,
              "unknown",
            );
          return { locator: null };
        } finally {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      async read({ storageKey: logical, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        const response = await request(
          objectUrl(key(logical, locator)),
          "GET",
          signal,
        );
        if (response.status !== 200 || !response.body) {
          const status = response.status;
          await discard(response);
          if (status === 404)
            throw new PluginError(
              "NOT_FOUND",
              "WebDAV object not found",
              false,
              "notApplied",
            );
          throw failure("GET", status, "notApplied");
        }
        const length = response.headers.get("content-length");
        const size =
          length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
        return {
          type: "stream",
          stream: retainStream(response.body, () => {}, signal),
          mimeType: response.headers.get("content-type") ?? undefined,
          byteSize:
            Number.isSafeInteger(size) &&
            (!response.headers.get("content-encoding") ||
              response.headers.get("content-encoding") === "identity")
              ? size
              : undefined,
        };
      },
      async delete({ storageKey: logical, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const signal = signalFor(ctx.signal);
        const response = await request(
          objectUrl(key(logical, locator)),
          "DELETE",
          signal,
        );
        const status = response.status;
        await discard(response);
        // 202 is asynchronous and 207 may contain failures; neither proves deletion.
        if (![200, 204, 404].includes(status))
          throw failure(
            "DELETE",
            status,
            status >= 400 && status < 500 ? "notApplied" : "unknown",
          );
      },
      async recoverWrite({ storageKey: logical }, ctx) {
        const signal = signalFor(ctx.signal);
        try {
          const response = await request(
            objectUrl(validKey(logical)),
            "HEAD",
            signal,
          );
          const status = response.status;
          await discard(response);
          // Standard WebDAV has no atomic PUT operation metadata. Existence and
          // matching length cannot prove which operation created the object.
          return { status: status === 404 ? "notStored" : "unknown" };
        } catch {
          return { status: "unknown" };
        }
      },
    };
  },
};
