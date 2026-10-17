import { isPluginError } from "../../plugin-sdk/api";
import { PluginError, type Definition, type Locator } from "../../plugin-sdk";
import { logicalKey as validateLogicalKey } from "../../plugin-sdk";

function validRoot(value: string) {
  return (
    value === "/" ||
    (value.startsWith("/") &&
      !value.endsWith("/") &&
      !/[\\\x00-\x1f\x7f]/.test(value) &&
      value
        .slice(1)
        .split("/")
        .every((part) => part && part !== "." && part !== ".."))
  );
}
function endpointUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%(?:2e|2f|5c)/i.test(url.pathname)
  )
    throw new Error();
  return url.href.replace(/\/$/, "");
}
function error(code: string, writing = false) {
  return new PluginError(
    "OPENLIST_" + code,
    "OpenList request failed",
    !writing,
    writing ? "unknown" : "notApplied",
  );
}

export const openListStorage: Definition<"storage"> = {
  id: "builtin.openlist",
  name: "OpenList",
  description:
    "Store files through an OpenList mount with a configured API token.",
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        title: "Endpoint",
        format: "uri",
        "x-immutable": true,
      },
      root: {
        type: "string",
        title: "Mount directory",
        minLength: 1,
        "x-immutable": true,
      },
      token: {
        type: "string",
        title: "API token",
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
    required: ["endpoint", "root", "token"],
    additionalProperties: false,
  },
  uiHints: { "/timeoutMs": { advanced: true } },
  translations: {
    "zh-CN": {
      name: "OpenList",
      description: "使用 API 令牌将文件存储到 OpenList 挂载目录。",
      configSchema: {
        "/properties/endpoint": { title: "端点" },
        "/properties/root": { title: "挂载目录" },
        "/properties/token": { title: "API 令牌" },
        "/properties/redirect": { title: "302 重定向" },
        "/properties/timeoutMs": { title: "超时（毫秒）" },
      },
    },
  },
  async validateConfig(config) {
    const issues: Array<{ path: string; message: string }> = [];
    try {
      endpointUrl(String(config.endpoint));
    } catch {
      issues.push({ path: "/endpoint", message: "Invalid OpenList endpoint" });
    }
    if (!validRoot(String(config.root)))
      issues.push({
        path: "/root",
        message:
          "Expected an absolute mount directory without traversal or trailing slash",
      });
    return issues;
  },
  async createInstance({ config, services }) {
    const endpoint = endpointUrl(String(config.endpoint));
    const root = String(config.root);
    if (!validRoot(root)) throw error("CONFIG");
    const signalFor = (signal: AbortSignal) =>
      AbortSignal.any([
        signal,
        AbortSignal.timeout(Number(config.timeoutMs ?? 30000)),
      ]);
    function pathFor(storageKey: string, locator: Locator) {
      const prefix = root === "/" ? "/" : root + "/";
      let path: unknown;
      try {
        path =
          locator === null
            ? prefix + validateLogicalKey(storageKey)
            : typeof locator === "object"
              ? locator.path
              : undefined;
        if (typeof path !== "string" || !path.startsWith(prefix))
          throw new Error();
        validateLogicalKey(path.slice(prefix.length));
      } catch {
        throw new PluginError(
          "LOCATOR",
          "Invalid OpenList locator",
          false,
          "notApplied",
        );
      }
      return path as string;
    }
    async function request(
      path: string,
      init: RequestInit,
      signal: AbortSignal,
    ) {
      const writing = path === "put";
      const deleting = path === "remove";
      try {
        const secret = (await services.readSecrets()).value;
        const headers = new Headers(init.headers);
        headers.set("Authorization", String(secret.token));
        const response = await fetch(endpoint + "/api/fs/" + path, {
          ...init,
          headers,
          signal,
          redirect: "error",
        });
        // OpenList often returns HTTP 200 even when its JSON code reports failure.
        if (!response.ok) {
          await response.body?.cancel();
          throw new PluginError(
            response.status === 401 || response.status === 403
              ? "OPENLIST_AUTH"
              : "OPENLIST_HTTP",
            "OpenList rejected the request",
            response.status === 429 || (!writing && response.status >= 500),
            (writing || deleting) && ![401, 403, 429].includes(response.status)
              ? "unknown"
              : "notApplied",
          );
        }
        const result = await response.json();
        if (result?.code !== 200) {
          const code = result?.code;
          throw new PluginError(
            code === 401 || code === 403 ? "OPENLIST_AUTH" : "OPENLIST_API",
            "OpenList rejected the request",
            code === 429 || (!writing && code >= 500),
            (writing || deleting) && ![401, 403, 429].includes(code)
              ? "unknown"
              : "notApplied",
          );
        }
        // As-Task=false must not be silently turned into a background task.
        if (writing && result.data?.task) throw error("ASYNC", true);
        return result.data;
      } catch (cause) {
        if (isPluginError(cause)) throw cause;
        throw new PluginError(
          writing ? "OPENLIST_WRITE" : "OPENLIST_REQUEST",
          "OpenList request failed",
          !writing,
          "unknown",
        );
      }
    }
    async function info(path: string, signal: AbortSignal) {
      const data = await request(
        "get",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, password: "" }),
        },
        signal,
      );
      if (!data || data.is_dir !== false || typeof data.raw_url !== "string")
        throw error("RESPONSE");
      // FsGet.header is directory HTML, not HTTP download headers. Unlike fs/link,
      // this endpoint does not provide driver cookies or custom download headers.
      const secrets = (await services.readSecrets()).value;
      try {
        const url = new URL(data.raw_url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error();
        const token = String(secrets.token);
        if (
          token &&
          (url.href.includes(token) ||
            decodeURIComponent(url.href).includes(token))
        )
          throw new Error();
        return { url: url.href };
      } catch {
        throw error("URL");
      }
    }
    return {
      async write({ storageKey, file }, ctx) {
        ctx.signal.throwIfAborted();
        const size = file.metadata.byteSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw new PluginError(
            "OPENLIST_SIZE",
            "OpenList upload requires a known file size",
            false,
            "notApplied",
          );
        const path = pathFor(storageKey, null);
        const signal = signalFor(ctx.signal);
        let reader: ReadableStreamDefaultReader<Uint8Array>;
        try {
          signal.throwIfAborted();
          reader = (await file.openRead()).getReader();
        } catch {
          throw new PluginError(
            "OPENLIST_INPUT",
            "Could not prepare OpenList upload",
            false,
            "notApplied",
          );
        }
        const abort = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              signal.throwIfAborted();
              const next = await reader.read();
              signal.throwIfAborted();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (cause) {
              controller.error(cause);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        try {
          await request(
            "put",
            {
              method: "PUT",
              body,
              headers: {
                "File-Path": encodeURIComponent(path),
                "As-Task": "false",
                Overwrite: "false",
                "Content-Length": String(size),
                "Content-Type":
                  file.metadata.mimeType ?? "application/octet-stream",
              },
            },
            signal,
          );
          return { locator: null };
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      async read({ storageKey, locator, mode }, ctx) {
        ctx.signal.throwIfAborted();
        const path = pathFor(storageKey, locator);
        const signal = signalFor(ctx.signal);
        const { url } = await info(path, signal);
        if (mode === "auto" && config.redirect !== false)
          return { type: "redirect", url };
        try {
          // Download signed/public URLs without the OpenList API token, even at the same origin.
          const response = await fetch(url, { signal, redirect: "follow" });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw error("READ");
          }
          const length = response.headers.get("content-length");
          const size =
            length !== null && /^\d+$/.test(length)
              ? Number(length)
              : undefined;
          return {
            type: "stream",
            stream: response.body,
            mimeType: response.headers.get("content-type") ?? undefined,
            byteSize:
              size !== undefined &&
              Number.isSafeInteger(size) &&
              !response.headers.has("content-encoding")
                ? size
                : undefined,
          };
        } catch {
          throw error("READ");
        }
      },
      async delete({ storageKey, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const path = pathFor(storageKey, locator);
        const slash = path.lastIndexOf("/");
        await request(
          "remove",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dir: path.slice(0, slash) || "/",
              names: [path.slice(slash + 1)],
            }),
          },
          signalFor(ctx.signal),
        );
      },
      // Neither presence nor size proves which PUT operation created an object.
      async recoverWrite() {
        return { status: "unknown" };
      },
    };
  },
};
