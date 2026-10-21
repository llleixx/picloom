import { AppError } from "../core/errors";
import { archiveFiles as readArchive } from "../infra/archive";
export { PACKAGE_LIMIT, crc32 } from "../infra/archive";
const invalid = () =>
  new AppError(
    "PLUGIN_PACKAGE_INVALID",
    "插件包无效：仅支持普通 ZIP 文件，最多 512 个条目、解压后 50 MB，路径不得越界",
  );
const invalidSegment = (p: string) =>
  !p ||
  p === "." ||
  p === ".." ||
  /[. ]$/.test(p) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p);
export function archiveFiles(bytes: Uint8Array) {
  try {
    return readArchive(bytes);
  } catch {
    throw invalid();
  }
}
export interface Manifest {
  id: string;
  version: string;
  kind: "path" | "storage" | "processor";
  apiVersion: 1;
  entry: string;
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
    m.entry.split("/").some(invalidSegment)
  )
    throw invalid();
  return {
    id: m.id,
    version: m.version,
    kind: m.kind,
    apiVersion: 1,
    entry: m.entry,
  };
}
