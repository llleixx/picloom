import { logicalKey as storageKey, retainStream } from "../../../../plugin-sdk";
import { PluginError, type Definition, type Locator } from "../../../../plugin-sdk";

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
  id: "builtin.webdav",
  name: "WebDAV storage",
  description: "Authenticated WebDAV storage with streamed reads",
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  translations: {
    "zh-CN": {
      name: "WebDAV 存储",
      description: "通过 WebDAV 认证存储并以流式方式读取文件",
      configSchema: {
        "/properties/endpoint": {
          title: "WebDAV 端点",
          description:
            "已存在的 WebDAV 根目录 URL；使用服务最终地址，不跟随重定向",
        },
        "/properties/keyPrefix": {
          title: "目录前缀",
          description:
            "相对于 WebDAV 端点的目录；留空使用端点目录，不要进行 URL 编码",
        },
        "/properties/timeoutMs": { title: "超时（毫秒）" },
        "/properties/username": { title: "用户名" },
        "/properties/password": { title: "密码或应用密码" },
      },
    },
  },
  configSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        title: "WebDAV endpoint",
        description:
          "Existing WebDAV root URL; use the final URL, redirects are refused",
        format: "uri",
        "x-immutable": true,
      },
      keyPrefix: {
        type: "string",
        title: "Directory Prefix",
        description:
          "Directory relative to the WebDAV endpoint. Leave empty to use the endpoint directory. Do not URL-encode.",
        default: "",
        "x-immutable": true,
      },
      timeoutMs: {
        type: "integer",
        title: "Timeout (ms)",
        minimum: 100,
        maximum: 120000,
        default: 30000,
      },
      username: {
        type: "string",
        title: "Username",
        minLength: 1,
        pattern: "^[^:\\u0000-\\u001f\\u007f]+$",
        "x-sensitive": true,
      },
      password: {
        type: "string",
        title: "Password or app password",
        minLength: 1,
        pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        "x-sensitive": true,
      },
    },
    required: ["endpoint", "username", "password"],
    additionalProperties: false,
  },
  uiHints: {
    "/timeoutMs": { advanced: true },
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
      AbortSignal.any([
        signal,
        AbortSignal.timeout(Number(config.timeoutMs ?? 30000)),
      ]);
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
