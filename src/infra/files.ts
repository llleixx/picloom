import * as sdkFiles from "../../plugin-sdk/files";
import { isPluginError } from "../../plugin-sdk/api";
import { reservedPrefix } from "../../shared/web-routes";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../core/errors";
import type { FileInput, Metadata, Output } from "../plugins/api";

export function prefix(value: string) {
  if (!value.startsWith("/") || !value.endsWith("/") || reservedPrefix(value))
    throw new AppError("INVALID_PREFIX", "Invalid public prefix");
  logicalKey(value.slice(1, -1));
  return value;
}
// Decode once, matching incoming URL paths while preserving literal % in filenames.
export function publicPathKey(pathname: string) {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    throw new AppError("INVALID_PATH", "Malformed URL");
  }
  if (!path.startsWith("/"))
    throw new AppError("INVALID_PATH", "Invalid public path");
  for (const segment of path.slice(1).split("/")) logicalKey(segment);
  return path;
}
export function publicPath(p: string, key: string) {
  return p + key.split("/").map(encodeURIComponent).join("/");
}

export function fileInput(path: string, metadata: Metadata): FileInput {
  return {
    metadata: Object.freeze({ ...metadata }),
    async openRead() {
      return Bun.file(path).stream();
    },
  };
}
export function scopedInput(input: FileInput, parent: AbortSignal) {
  const controller = new AbortController();
  const completions: Promise<void>[] = [];
  const signal = AbortSignal.any([parent, controller.signal]);
  const file: FileInput = {
    metadata: input.metadata,
    async openRead() {
      signal.throwIfAborted();
      const stream = await input.openRead();
      let done!: () => void;
      completions.push(
        new Promise<void>((resolve) => {
          done = resolve;
        }),
      );
      return retainStream(stream, done, signal);
    },
  };
  return {
    file,
    async close() {
      controller.abort();
      await Promise.all(completions);
    },
  };
}
export function output(path: string, write: Output["write"]): Output {
  return {
    ...fileInput(path, {
      mimeType: null,
      byteSize: null,
      width: null,
      height: null,
    }),
    write,
    handle: crypto.randomUUID(),
  };
}
// Read one chunk before committing to a replica; never buffer the whole object.
export async function prefetchStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    signal.throwIfAborted();
    first = await reader.read();
    signal.throwIfAborted();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (first.done) {
    reader.releaseLock();
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
  }
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        c.enqueue(first.value!);
      },
      async pull(c) {
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            c.close();
          } else c.enqueue(next.value);
        } catch (error) {
          reader.releaseLock();
          c.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

// Linux containers can reuse the same PID after a restart. Distinguish the
// process incarnation so an interrupted upload does not leave a permanent lock.
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    return `${boot}:${start}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function workLock(root: string) {
  await mkdir(root, { recursive: true });
  const path = join(root, "service.lock");
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const f = await open(path, "wx");
      try {
        await f.writeFile(
          JSON.stringify({
            pid: process.pid,
            token,
            processIdentity: await processIdentity(process.pid),
          }),
        );
      } finally {
        await f.close();
      }
      return async () => {
        try {
          const saved = JSON.parse(await readFile(path, "utf8"));
          if (saved.token === token) await remove(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let saved: { pid: number; processIdentity?: string };
      try {
        saved = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(
          "Unreadable service.lock; verify no service is running before removing it",
        );
      }
      if (
        saved.processIdentity &&
        saved.processIdentity !== (await processIdentity(saved.pid))
      ) {
        await remove(path);
        continue;
      }
      try {
        process.kill(saved.pid, 0);
        throw new Error("Data directory is already in use");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await remove(path);
    }
  }
  throw new Error("Could not acquire data directory lock");
}

// Map public file utilities to HTTP-domain errors at the core boundary.
function fileError(error: unknown): never {
  if (isPluginError(error))
    throw new AppError(
      error.code,
      error.message,
      error.code === "TOO_LARGE" ? 413 : 400,
    );
  throw error;
}
export function logicalKey(key: string) {
  try {
    return sdkFiles.logicalKey(key);
  } catch (error) {
    fileError(error);
  }
}
export function contained(root: string, key: string) {
  try {
    return sdkFiles.contained(root, key);
  } catch (error) {
    fileError(error);
  }
}
export async function safePath(
  root: string,
  key: string,
  createParents = false,
) {
  try {
    return await sdkFiles.safePath(root, key, createParents);
  } catch (error) {
    fileError(error);
  }
}
export async function writeStream(
  ...args: Parameters<typeof sdkFiles.writeStream>
) {
  try {
    return await sdkFiles.writeStream(...args);
  } catch (error) {
    fileError(error);
  }
}
export const remove = sdkFiles.remove;
export const retainStream = sdkFiles.retainStream;
