import { mkdir, readdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../config";
import { AppError } from "../core/errors";
import { remove, writeStream } from "./files";

/** One process owns this workspace. Account reservations before starting I/O. */
export class TemporarySpace {
  private entries = new Map<string, number>();
  private used = 0;
  private receiving = 0;
  private pendingRemoval = new Set<string>();
  constructor(private config: Settings) {}
  get bytes() {
    return this.used;
  }
  size(key: string) {
    return this.entries.get(key) ?? 0;
  }
  reserve(key: string, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid temporary reservation");
    const delta = bytes - this.size(key);
    if (delta > 0 && this.used + delta > this.config.uploadTempBytes)
      throw new AppError(
        "TEMP_CAPACITY",
        "Temporary space is full; retry later",
        503,
      );
    this.entries.set(key, bytes);
    this.used += delta;
  }
  release(key: string) {
    this.used -= this.size(key);
    this.entries.delete(key);
  }
  create(bytes = 0) {
    const path = join(this.config.root, "temp", crypto.randomUUID());
    this.reserve(path, bytes);
    return path;
  }
  enterUpload() {
    if (this.receiving >= this.config.uploadConcurrency)
      throw new AppError("BUSY", "Upload capacity is full; retry later", 503);
    this.receiving++;
    let ended = false;
    return () => {
      if (!ended) {
        ended = true;
        this.receiving--;
      }
    };
  }
  async remove(path: string) {
    try {
      await remove(path);
      this.release(path);
      this.pendingRemoval.delete(path);
    } catch (error) {
      this.pendingRemoval.add(path);
      throw error;
    }
  }
  async clean() {
    for (const path of [...this.pendingRemoval]) {
      try {
        await this.remove(path);
      } catch {
        console.warn(JSON.stringify({ event: "temp_cleanup_failed" }));
      }
    }
  }
  async write(
    path: string,
    stream: ReadableStream<Uint8Array>,
    limit: number,
    signal?: AbortSignal,
  ) {
    let received = 0;
    const accounted = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          received += chunk.byteLength;
          if (received > limit)
            throw new AppError("TOO_LARGE", "File exceeds size limit", 413);
          if (received > this.size(path)) this.reserve(path, received);
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      const size = await writeStream(path, accounted, limit, signal);
      this.reserve(path, size);
      return size;
    } catch (error) {
      await accounted.cancel().catch(() => {});
      await this.remove(path);
      throw error;
    }
  }
  // Move an assembled file out of its session without copying or double accounting.
  async takeSession(key: string, source: string, size: number) {
    if (size > this.size(key)) throw new Error("Missing upload reservation");
    const path = join(this.config.root, "temp", crypto.randomUUID());
    await rename(source, path);
    this.reserve(key, this.size(key) - size);
    this.entries.set(path, size);
    this.used += size;
    return path;
  }
  restore(key: string, bytes: number) {
    // Existing files survive a lowered limit; only new allocations are rejected.
    this.used += bytes - this.size(key);
    this.entries.set(key, bytes);
  }
  async recover() {
    const root = join(this.config.root, "temp");
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(root, entry.name);
      this.restore(path, (await stat(path)).size);
    }
  }
}
