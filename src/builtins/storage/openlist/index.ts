import { scanScope, decodeCursor, encodeCursor } from "../shared/enumeration";
import { isPluginError } from "../../../../plugin-sdk/api";
import {
  PluginError,
  type Definition,
  type Locator,
} from "../../../../plugin-sdk";
import { logicalKey as validateLogicalKey } from "../../../../plugin-sdk";

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
    code === "CONFIG"
      ? "INVALID_CONFIG"
      : code === "RESPONSE" || code === "URL"
        ? "INVALID_DATA"
        : "SERVICE",
    "OpenList request failed",
    !writing,
    writing ? "unknown" : "notApplied",
  );
}

export const openListStorage: Definition<"storage"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "OpenList Storage",
      "package.description":
        "Store files through an OpenList mount with a configured API token.",
      "settings.endpoint.label": "Endpoint",
      "settings.root.label": "Mount directory",
      "settings.token.label": "API token",
      "settings.redirect.label": "Redirect reads (302)",
      "settings.timeoutMs.label": "Timeout (ms)",
    },
    "zh-CN": {
      "package.name": "OpenList 存储",
      "package.description": "使用 API 令牌将文件存储到 OpenList 挂载目录。",
      "settings.endpoint.label": "端点",
      "settings.root.label": "挂载目录",
      "settings.token.label": "API 令牌",
      "settings.redirect.label": "302 重定向",
      "settings.timeoutMs.label": "超时（毫秒）",
    },
  },

  id: "builtin.openlist",

  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      endpoint: {
        "x-ui": { labelKey: "settings.endpoint.label" },
        type: "string",

        format: "uri",
        "x-immutable": true,
      },
      root: {
        "x-ui": { labelKey: "settings.root.label" },
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
      token: {
        "x-ui": { labelKey: "settings.token.label" },
        type: "string",

        minLength: 1,
        "x-sensitive": true,
      },
      redirect: {
        "x-ui": { labelKey: "settings.redirect.label" },
        type: "boolean",

        default: true,
      },
      timeoutMs: {
        "x-ui": { labelKey: "settings.timeoutMs.label", advanced: true },
        type: "integer",

        minimum: 100,
        maximum: 120000,
        default: 30000,
      },
    },
    required: ["endpoint", "root", "token", "timeoutMs"],
    additionalProperties: false,
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
      AbortSignal.any([signal, AbortSignal.timeout(Number(config.timeoutMs))]);
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
          "INVALID_INPUT",
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
      let headers: Headers;
      try {
        signal.throwIfAborted();
        const secret = (await services.readSecrets()).value;
        headers = new Headers(init.headers);
        headers.set("Authorization", String(secret.token));
        signal.throwIfAborted();
      } catch {
        throw new PluginError(
          "FAILED",
          "Could not prepare OpenList request",
          false,
          "notApplied",
        );
      }
      let response: Response;
      try {
        response = await fetch(endpoint + "/api/fs/" + path, {
          ...init,
          headers,
          signal,
          redirect: "error",
        });
      } catch (cause) {
        // Connection refusal means the request never reached the server.
        const refused =
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ECONNREFUSED";
        throw new PluginError(
          "NETWORK",
          "OpenList request failed",
          refused || !writing,
          refused ? "notApplied" : "unknown",
        );
      }
      try {
        // OpenList often returns HTTP 200 even when its JSON code reports failure.
        if (!response.ok) {
          await response.body?.cancel();
          throw new PluginError(
            response.status === 401 || response.status === 403
              ? "ACCESS_DENIED"
              : response.status === 429
                ? "RATE_LIMITED"
                : "SERVICE",
            "OpenList rejected the request",
            response.status === 429 || (!writing && response.status >= 500),
            (writing || deleting) && ![401, 403, 429].includes(response.status)
              ? "unknown"
              : "notApplied",
          );
        }
        let result;
        try {
          result = await response.json();
        } catch (cause) {
          // A malformed response cannot confirm whether a write took effect.
          if (cause instanceof SyntaxError)
            throw new PluginError(
              "INVALID_DATA",
              "Invalid OpenList response",
              !writing,
              "unknown",
            );
          throw cause;
        }
        if (result?.code !== 200) {
          const code = result?.code;
          throw new PluginError(
            code === 401 || code === 403
              ? "ACCESS_DENIED"
              : code === 429
                ? "RATE_LIMITED"
                : "SERVICE",
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
          "NETWORK",
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
      async listFiles({ scope: inputScope, cursor, limit }, ctx) {
        const scope = scanScope(inputScope);
        const pageSize = 200;
        type Frame = { directory: string; page: number; index: number };
        type Entry = { name: string; is_dir: boolean; size: number };
        const stack = decodeCursor<Frame[]>(cursor, scope) ?? [
          { directory: scope, page: 1, index: 0 },
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
              (scope &&
                frame.directory !== scope &&
                !frame.directory.startsWith(scope + "/")) ||
              !Number.isSafeInteger(frame.page) ||
              frame.page < 1 ||
              !Number.isSafeInteger(frame.index) ||
              frame.index < 0 ||
              frame.index > pageSize,
          )
        )
          throw new PluginError(
            "INVALID_INPUT",
            "Invalid scan cursor or limit",
          );
        for (const frame of stack) {
          if (frame.directory) validateLogicalKey(frame.directory);
        }
        // Cache active directory pages only for this call; cursors contain positions, not listings.
        const pages = new Map<Frame, { content: Entry[]; total: number }>();
        const items: Array<{ storageKey: string; byteSize: number }> = [];
        let requests = 0;
        while (stack.length && items.length < limit) {
          ctx.signal.throwIfAborted();
          const frame = stack.at(-1)!;
          let data = pages.get(frame);
          if (!data) {
            // Bound work even when traversing directories containing no files.
            if (requests++ >= 8) break;
            const result = await request(
              "list",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  path: frame.directory ? pathFor(frame.directory, null) : root,
                  password: "",
                  refresh: false,
                  page: frame.page,
                  per_page: pageSize,
                }),
              },
              signalFor(ctx.signal),
            );
            if (
              !result ||
              !Number.isSafeInteger(result.total) ||
              result.total < 0
            )
              throw error("RESPONSE");
            // OpenList serializes an empty content slice as null.
            const content =
              result.content ?? (result.total === 0 ? [] : undefined);
            if (
              !Array.isArray(content) ||
              content.length > pageSize ||
              (!content.length && (frame.page - 1) * pageSize < result.total)
            )
              throw error("RESPONSE");
            for (const entry of content) {
              if (
                !entry ||
                typeof entry.name !== "string" ||
                entry.name.includes("/") ||
                typeof entry.is_dir !== "boolean" ||
                !Number.isSafeInteger(entry.size) ||
                entry.size < 0
              )
                throw error("RESPONSE");
              try {
                validateLogicalKey(entry.name);
              } catch {
                throw error("RESPONSE");
              }
            }
            data = { content, total: result.total };
            pages.set(frame, data);
          }
          if (frame.index >= data.content.length) {
            pages.delete(frame);
            if (frame.page * pageSize >= data.total) stack.pop();
            else {
              frame.page++;
              frame.index = 0;
            }
            continue;
          }
          const entry = data.content[frame.index++]!;
          const storageKey = frame.directory
            ? frame.directory + "/" + entry.name
            : entry.name;
          if (entry.is_dir)
            stack.push({ directory: storageKey, page: 1, index: 0 });
          else items.push({ storageKey, byteSize: entry.size });
        }
        const nextCursor = stack.length ? encodeCursor(scope, stack) : null;
        if (nextCursor && nextCursor.length > 32768)
          throw new PluginError(
            "INVALID_INPUT",
            "Scan is too deep; choose a narrower scope",
          );
        return { items, nextCursor };
      },
      async write({ storageKey, file }, ctx) {
        ctx.signal.throwIfAborted();
        const size = file.metadata.byteSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw new PluginError(
            "INVALID_INPUT",
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
            "FAILED",
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
