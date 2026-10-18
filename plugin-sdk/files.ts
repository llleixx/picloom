import { mkdir, open, unlink, realpath, lstat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { PluginError } from "./api";
export function logicalKey(key: string) {
  if (
    !key ||
    key.length > 2048 ||
    /[\\\x00-\x1f\x7f?#:]/.test(key) ||
    key.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw new PluginError("INVALID_INPUT", "Invalid logical path");
  return key;
}
export function contained(root: string, key: string) {
  logicalKey(key);
  const path = resolve(root, key);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new PluginError("INVALID_INPUT", "Path outside root");
  return path;
}
export async function safePath(
  root: string,
  key: string,
  createParents = false,
) {
  const path = contained(root, key);
  const canonical = await realpath(root);
  const parts = relative(resolve(root), path).split(/[\\/]/);
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink())
        throw new PluginError(
          "INVALID_INPUT",
          "Symbolic links are not supported",
        );
      const actual = await realpath(current);
      const r = relative(canonical, actual);
      if (r.startsWith("..") || isAbsolute(r))
        throw new PluginError("INVALID_INPUT", "Path outside root");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
  }
  if (createParents) await mkdir(dirname(path), { recursive: true });
  return path;
}
export async function remove(path: string) {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export async function writeStream(
  path: string,
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal,
) {
  const file = await open(path, "wx");
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit)
        throw new PluginError(
          "RESOURCE_LIMIT",
          "File exceeds size limit",
          false,
          "notApplied",
        );
      let offset = 0;
      while (offset < value.length) {
        const result = await file.write(value, offset, value.length - offset);
        offset += result.bytesWritten;
      }
    }
    signal?.throwIfAborted();
    await file.sync();
    return total;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close();
  }
}
export function retainStream(
  stream: ReadableStream<Uint8Array>,
  release: () => void | Promise<void>,
  signal?: AbortSignal,
) {
  const reader = stream.getReader();
  let ended = false;
  let cancelling = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = async () => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {}
    await release();
  };
  const abort = () => {
    if (ended || cancelling) return;
    cancelling = true;
    try {
      controller.error(new Error("Cancelled"));
    } catch {}
    void reader
      .cancel()
      .catch(() => {})
      .finally(async () => {
        await finish();
      })
      .catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(c) {
      try {
        const result = await reader.read();
        if (ended || cancelling) return;
        if (result.done) {
          c.close();
          await finish();
        } else c.enqueue(result.value);
      } catch (e) {
        if (cancelling) return;
        if (!ended) c.error(e);
        await finish();
      }
    },
    async cancel(reason) {
      cancelling = true;
      try {
        await reader.cancel(reason);
      } finally {
        await finish();
      }
    },
  });
}

/** Cancel a stream-backed operation, then wait for its actual completion. */
export async function withAbortSignal<T extends { destroy(): unknown }, R>(
  resource: T,
  signal: AbortSignal | undefined,
  operation: () => Promise<R>,
): Promise<R> {
  const abort = () => {
    resource.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    signal?.throwIfAborted();
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    resource.destroy();
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
