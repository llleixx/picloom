import { xxhash128 } from "hash-wasm";
import {
  open,
  mkdir,
  readFile,
  readdir,
  stat,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { join, sep } from "node:path";
import { Mutex } from "./concurrency";
import type { Metadata } from "../plugins/api";
import type { Instance, Step } from "../persistence/port";
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function cacheKey(
  fileId: string,
  params: unknown,
  steps: Array<{
    step: Step;
    record: Instance;
    cacheConfig?: import("../plugins/api").Config;
  }>,
) {
  return xxhash128(
    stable({
      fileId,
      params,
      steps: steps.map(({ step, record, cacheConfig }) => ({
        plugin: record.plugin_id,
        version: record.plugin_version,
        instance: record.id,
        config: cacheConfig ?? record.config_json,
        step: {
          on_not_applicable: step.on_not_applicable,
          enabledParams: [...step.enabled_params].sort(),
        },
      })),
    }),
  );
}
export interface ImageResult {
  cacheIdentity?: string;
  bytes: Uint8Array;
  metadata: Metadata;
}
export interface CachedImage {
  cacheIdentity?: string;
  stream: ReadableStream<Uint8Array>;
  size: number;
  metadata: Metadata;
}
export class ImageCache {
  private mutex = new Mutex();
  private lastClean = 0;
  private bytes = 0;
  private entries = new Map<string, { size: number; time: number }>();
  configure(maxBytes: number, ttl: number) {
    this.maxBytes = maxBytes;
    this.ttl = ttl;
    this.lastClean = 0;
  }
  async clear() {
    await this.mutex.run(async () => {
      await rm(this.root, { recursive: true, force: true });
      await mkdir(this.root, { recursive: true });
      this.entries.clear();
      this.bytes = 0;
      this.lastClean = Date.now();
    });
  }
  constructor(
    private root: string,
    private maxBytes: number,
    private ttl: number,
  ) {}
  async get(fileId: string, key: string): Promise<CachedImage | null> {
    return this.mutex.run(async () => {
      const dir = join(this.root, fileId, key);
      try {
        const meta = JSON.parse(
          await readFile(join(dir, "meta.json"), "utf8"),
        ) as { created: number; metadata: Metadata; cacheIdentity?: string };
        if (meta.created + this.ttl < Date.now()) {
          await rm(dir, { recursive: true, force: true });
          this.forget(dir);
          return null;
        }
        // Open under the publication lock; the response reads outside it.
        // An opened file remains readable when its cache entry is replaced/unlinked.
        const file = await open(join(dir, "image"), "r");
        try {
          const size = (await file.stat()).size;
          return {
            metadata: meta.metadata,
            cacheIdentity: meta.cacheIdentity,
            size,
            stream: Readable.toWeb(file.createReadStream(), {
              strategy: {
                highWaterMark: 64 * 1024,
                size: (chunk) => chunk.byteLength,
              },
            }) as unknown as ReadableStream<Uint8Array>,
          };
        } catch (error) {
          await file.close();
          throw error;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn(JSON.stringify({ event: "cache_read_failed" }));
        return null;
      }
    });
  }
  async put(fileId: string, key: string, result: ImageResult) {
    try {
      await this.mutex.run(async () => {
        if (result.bytes.byteLength > this.maxBytes) return;
        await this.cleanLocked(false, result.bytes.byteLength);
        const parent = join(this.root, fileId);
        await mkdir(parent, { recursive: true });
        const temp = join(parent, `.tmp-${crypto.randomUUID()}`);
        await mkdir(temp);
        try {
          await Bun.write(join(temp, "image"), result.bytes);
          await Bun.write(
            join(temp, "meta.json"),
            JSON.stringify({
              created: Date.now(),
              metadata: result.metadata,
              cacheIdentity: result.cacheIdentity,
            }),
          );
          await rm(join(parent, key), { recursive: true, force: true });
          this.forget(join(parent, key));
          await rename(temp, join(parent, key));
          this.bytes += result.bytes.byteLength;
          this.entries.set(join(parent, key), {
            size: result.bytes.byteLength,
            time: Date.now(),
          });
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      });
    } catch {
      // Caching is optional: never fail a generated image because the cache is full/unwritable.
      console.warn(JSON.stringify({ event: "cache_write_failed" }));
    }
  }
  async remove(fileId: string) {
    await this.mutex.run(async () => {
      const parent = join(this.root, fileId);
      await rm(parent, { recursive: true, force: true });
      for (const path of this.entries.keys())
        if (path.startsWith(parent + sep)) this.forget(path);
    });
  }
  private forget(path: string) {
    this.bytes -= this.entries.get(path)?.size ?? 0;
    this.entries.delete(path);
  }
  async clean(force = true) {
    await this.mutex.run(() => this.cleanLocked(force));
  }
  private async cleanLocked(force: boolean, incoming = 0) {
    if (force || Date.now() - this.lastClean >= 300_000) {
      await mkdir(this.root, { recursive: true });
      this.lastClean = 0;
      this.entries.clear();
      this.bytes = 0;
      for (const f of await readdir(this.root, { withFileTypes: true })) {
        if (!f.isDirectory() || f.isSymbolicLink()) continue;
        const parent = join(this.root, f.name);
        try {
          for (const k of await readdir(parent, { withFileTypes: true })) {
            if (!k.isDirectory() || k.isSymbolicLink()) continue;
            const path = join(parent, k.name);
            try {
              if (k.name.startsWith(".tmp-")) {
                await rm(path, { recursive: true, force: true });
                continue;
              }
              const image = await stat(join(path, "image"));
              this.entries.set(path, { size: image.size, time: image.mtimeMs });
              this.bytes += image.size;
              const meta = JSON.parse(
                await readFile(join(path, "meta.json"), "utf8"),
              );
              if (
                !meta ||
                !Number.isFinite(meta.created) ||
                !meta.metadata ||
                typeof meta.metadata.mimeType !== "string" ||
                meta.metadata.byteSize !== image.size ||
                Math.min(image.mtimeMs, meta.created) + this.ttl < Date.now()
              ) {
                await rm(path, { recursive: true, force: true });
                this.forget(path);
              }
            } catch (error) {
              try {
                if (
                  error instanceof SyntaxError ||
                  (error as NodeJS.ErrnoException).code === "ENOENT"
                ) {
                  await rm(path, { recursive: true, force: true });
                  this.forget(path);
                } else throw error;
              } catch {
                console.warn(JSON.stringify({ event: "cache_cleanup_failed" }));
              }
            }
          }
          await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
            if (!["ENOTEMPTY", "ENOENT"].includes(error.code ?? ""))
              throw error;
          });
        } catch {
          console.warn(JSON.stringify({ event: "cache_cleanup_failed" }));
        }
      }
      this.lastClean = Date.now();
    }
    if (this.bytes + incoming <= this.maxBytes) return;
    for (const [path, item] of [...this.entries].sort(
      (a, b) => a[1].time - b[1].time,
    )) {
      if (
        item.time + this.ttl >= Date.now() &&
        this.bytes + incoming <= this.maxBytes
      )
        break;
      try {
        await rm(path, { recursive: true, force: true });
        this.forget(path);
      } catch {
        console.warn(JSON.stringify({ event: "cache_cleanup_failed" }));
      }
    }
  }
}
