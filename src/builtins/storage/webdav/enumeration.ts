import { SaxesParser } from "saxes";
import { PluginError, isPluginError, logicalKey } from "../../../../plugin-sdk";

type Node = { name: string; text: string; children: Node[] };
export type DirectoryEntry = {
  name: string;
  directory: boolean;
  byteSize?: number;
  mimeType?: string;
};
const children = (node: Node, name: string) =>
  node.children.filter((n) => n.name === name);
const child = (node: Node, name: string) => children(node, name)[0];
const invalid = () =>
  new PluginError("INVALID_DATA", "Invalid WebDAV directory listing");
function status(node: Node | undefined) {
  const match = node?.text.trim().match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/);
  if (!match) throw invalid();
  return Number(match[1]);
}
function checkStatus(code: number) {
  if (code < 200 || code >= 300)
    throw new PluginError(
      code === 401 || code === 403 ? "ACCESS_DENIED" : "SERVICE",
      "WebDAV directory entry failed (HTTP " + code + ")",
      code >= 500,
    );
}

// Read one Depth: 1 listing. Keep only the current XML response and parsed entries.
export async function readDirectory(
  response: Response,
  directory: URL,
  signal: AbortSignal,
) {
  if (!response.body) throw invalid();
  const entries = new Map<string, DirectoryEntry>();
  const stack: Node[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let rootSeen = false;
  parser.on("doctype", () => {
    throw invalid();
  });
  parser.on("opentag", (tag) => {
    const name = tag.uri === "DAV:" ? tag.local : "";
    if (!stack.length) {
      if (rootSeen || name !== "multistatus") throw invalid();
      rootSeen = true;
    }
    if (stack.length >= 32) throw invalid();
    const node: Node = { name, text: "", children: [] };
    stack.at(-1)?.children.push(node);
    stack.push(node);
  });
  const text = (value: string) => {
    if (stack.length) stack.at(-1)!.text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    const node = stack.pop()!;
    if (stack.length !== 1) return;
    if (node.name === "response") {
      const href = child(node, "href")?.text.trim();
      if (!href) throw invalid();
      // Validate segments before URL normalization can erase traversal components.
      if (href.includes("\\") || /[\x00-\x20\x7f]/.test(href)) throw invalid();
      const url = new URL(href, directory);
      const rawPath = href.replace(/^https?:\/\/[^/]+/i, "");
      for (const part of rawPath.split("/")) {
        const decoded = decodeURIComponent(part);
        if (
          decoded === "." ||
          decoded === ".." ||
          /[\\/\x00-\x1f\x7f]/.test(decoded)
        )
          throw invalid();
      }
      if (
        url.origin !== directory.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw invalid();
      const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
      const parent = decodeURIComponent(directory.pathname).replace(/\/$/, "");
      if (path !== parent && !path.startsWith(parent + "/")) throw invalid();
      const name = path === parent ? "" : path.slice(parent.length + 1);
      if (name.includes("/")) throw invalid();
      if (name) logicalKey(name);
      const responseStatus = child(node, "status");
      if (responseStatus) checkStatus(status(responseStatus));
      const properties: Node[] = [];
      for (const propstat of children(node, "propstat")) {
        const code = status(child(propstat, "status"));
        const props = child(propstat, "prop")?.children ?? [];
        if (code >= 200 && code < 300) properties.push(...props);
        // Missing optional metadata is fine; an unreadable resource type is not.
        else if (props.some((p) => p.name === "resourcetype"))
          checkStatus(code);
      }
      const type = properties.find((p) => p.name === "resourcetype");
      if (!type) throw invalid();
      const isDirectory = !!child(type, "collection");
      if (!name) {
        if (!isDirectory) throw invalid();
        stack[0]!.children = [];
        return;
      }
      const size = properties
        .find((p) => p.name === "getcontentlength")
        ?.text.trim();
      if (
        size !== undefined &&
        (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)))
      )
        throw invalid();
      const mimeType =
        properties
          .find((p) => p.name === "getcontenttype")
          ?.text.split(";", 1)[0]
          ?.trim()
          .toLowerCase() || undefined;
      if (entries.has(name)) throw invalid();
      entries.set(name, {
        name,
        directory: isDirectory,
        byteSize: size === undefined ? undefined : Number(size),
        mimeType:
          mimeType === "application/octet-stream" ? undefined : mimeType,
      });
    }
    stack[0]!.children = [];
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8 * 1024 * 1024)
        throw new PluginError(
          "RESOURCE_LIMIT",
          "WebDAV directory listing exceeds 8 MiB; narrow the scan scope or split the directory",
        );
      parser.write(decoder.decode(chunk.value, { stream: true }));
    }
    parser.write(decoder.decode()).close();
    if (!rootSeen) throw invalid();
    return [...entries.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    if (isPluginError(error)) throw error;
    if (signal.aborted) throw signal.reason;
    throw invalid();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
