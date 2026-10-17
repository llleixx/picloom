import { inflateRawSync } from "node:zlib";
import { AppError } from "../core/errors";
export const PACKAGE_LIMIT = 20 * 1024 * 1024;
const EXPANDED_LIMIT = 50 * 1024 * 1024;
const invalidSegment = (p: string) =>
  !p ||
  p === "." ||
  p === ".." ||
  /[. ]$/.test(p) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p);
const invalid = () =>
  new AppError(
    "PLUGIN_PACKAGE_INVALID",
    "插件包无效：仅支持普通 ZIP 文件，最多 512 个条目、解压后 50 MB，路径不得越界",
  );
export function archiveFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!bytes.length || bytes.length > PACKAGE_LIMIT) throw invalid();
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (
    end >= Math.max(0, b.length - 65557) &&
    b.readUInt32LE(end) !== 0x06054b50
  )
    end--;
  if (
    end < 0 ||
    end < b.length - 65557 ||
    end + 22 + b.readUInt16LE(end + 20) !== b.length
  )
    throw invalid();
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    b.readUInt16LE(end + 8) !== count ||
    count > 512 ||
    !count ||
    start + size !== end
  )
    throw invalid();
  const entries: Array<{
    name: string;
    raw: Uint8Array;
    method: number;
    size: number;
    crc: number;
  }> = [];
  const names = new Set<string>();
  let at = start,
    total = 0;
  try {
    for (let n = 0; n < count; n++) {
      if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50) throw invalid();
      const flags = b.readUInt16LE(at + 8),
        method = b.readUInt16LE(at + 10),
        compressed = b.readUInt32LE(at + 20),
        expanded = b.readUInt32LE(at + 24),
        len = b.readUInt16LE(at + 28),
        extra = b.readUInt16LE(at + 30),
        comment = b.readUInt16LE(at + 32),
        local = b.readUInt32LE(at + 42);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        b.subarray(at + 46, at + 46 + len),
      );
      const unixType = (b.readUInt32LE(at + 38) >>> 16) & 0xf000;
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        b.readUInt16LE(at + 34) ||
        compressed === 0xffffffff ||
        expanded === 0xffffffff ||
        local === 0xffffffff ||
        at + 46 + len + extra + comment > end ||
        !name ||
        name.length > 240 ||
        /[\\:<>"|?*\x00-\x1f]/.test(name) ||
        name.startsWith("/") ||
        name.replace(/\/$/, "").split("/").some(invalidSegment) ||
        names.has(name.toLowerCase()) ||
        ![0, 0x8000, 0x4000].includes(unixType)
      )
        throw invalid();
      names.add(name.toLowerCase());
      total += expanded;
      if (
        total > EXPANDED_LIMIT ||
        local + 30 > start ||
        b.readUInt32LE(local) !== 0x04034b50 ||
        b.readUInt16LE(local + 8) !== method ||
        b.readUInt16LE(local + 6) !== flags
      )
        throw invalid();
      const localLen = b.readUInt16LE(local + 26),
        data = local + 30 + localLen + b.readUInt16LE(local + 28);
      if (
        data + compressed > start ||
        !b
          .subarray(local + 30, local + 30 + localLen)
          .equals(b.subarray(at + 46, at + 46 + len))
      )
        throw invalid();
      if (name.endsWith("/")) {
        if (expanded !== 0) throw invalid();
      } else
        entries.push({
          name,
          raw: b.subarray(data, data + compressed),
          method,
          size: expanded,
          crc: b.readUInt32LE(at + 16),
        });
      at += 46 + len + extra + comment;
    }
    if (at !== end) throw invalid();
    const result = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const data =
        entry.method === 0
          ? Buffer.from(entry.raw)
          : inflateRawSync(entry.raw, {
              maxOutputLength: Math.max(1, entry.size),
            });
      if (data.length !== entry.size || crc32(data) !== entry.crc)
        throw invalid();
      result.set(entry.name, data);
    }
    return result;
  } catch {
    throw invalid();
  }
}
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of data) crc = table[(crc ^ value) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface Manifest {
  id: string;
  version: string;
  kind: "path" | "storage" | "processor";
  apiVersion: 1;
  entry: string;
  name?: string;
}
export function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const m = value as Manifest;
  if (
    typeof m.id !== "string" ||
    !/^[a-z][a-z0-9._-]{0,99}$/.test(m.id) ||
    m.id.startsWith("builtin.") ||
    typeof m.version !== "string" ||
    !/^[0-9][a-zA-Z0-9.+-]{0,63}$/.test(m.version) ||
    m.apiVersion !== 1 ||
    !["path", "storage", "processor"].includes(m.kind) ||
    typeof m.entry !== "string" ||
    !m.entry.endsWith(".js") ||
    m.entry.startsWith("/") ||
    /[\\:<>"|?*\x00-\x1f]/.test(m.entry) ||
    m.entry.split("/").some(invalidSegment) ||
    (m.name !== undefined &&
      (typeof m.name !== "string" || !m.name.trim() || m.name.length > 100))
  )
    throw invalid();
  return {
    id: m.id,
    version: m.version,
    kind: m.kind,
    apiVersion: 1,
    entry: m.entry,
    ...(m.name ? { name: m.name } : {}),
  };
}
