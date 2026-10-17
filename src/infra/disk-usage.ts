import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { LocalUsage } from "../../shared/api";
const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return (
    !path || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
};
/** No traversal through child symlinks. Deduplicate roots and hard links. */
export async function directoryBytes(
  roots: string[],
  excluded: string[] = [],
): Promise<number | null> {
  try {
    const paths = [
      ...new Set(await Promise.all(roots.map((path) => realpath(path)))),
    ];
    const exclude = await Promise.all(excluded.map((path) => realpath(path)));
    const queue = paths.filter(
      (path) => !paths.some((other) => path !== other && inside(path, other)),
    );
    const seen = new Set<string>();
    let bytes = 0;
    while (queue.length) {
      const path = queue.pop()!;
      if (exclude.some((other) => inside(path, other))) continue;
      let item;
      try {
        item = await lstat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (item.isSymbolicLink()) continue;
      const key = `${item.dev}:${item.ino}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.isFile()) bytes += item.size;
      else if (item.isDirectory()) {
        try {
          for (const entry of await readdir(path))
            queue.push(join(path, entry));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    }
    return bytes;
  } catch {
    return null;
  }
}
export async function localUsage(
  root: string,
  originalRoots: string[],
): Promise<Omit<LocalUsage, "calculating">> {
  const temporary = join(root, "temp"),
    cache = join(root, "cache");
  const uploads = await realpath(join(root, "uploads")).catch(() => null);
  const staging = [temporary, ...(uploads ? [uploads] : [])];
  const [originals, tempBytes, cacheBytes, disk] = await Promise.all([
    directoryBytes(originalRoots, [...staging, cache]),
    directoryBytes(staging),
    directoryBytes([cache]),
    statfs(root).catch(() => null),
  ]);
  return {
    measuredAt: Date.now(),
    originals,
    temporary: tempBytes,
    cache: cacheBytes,
    diskTotal: disk ? disk.blocks * disk.bsize : null,
    diskAvailable: disk ? disk.bavail * disk.bsize : null,
  };
}
