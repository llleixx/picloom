import { xxhash128 } from "hash-wasm";
import { mkdir, readFile, readdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
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
export class ImageCache {
  private mutex = new Mutex();
  private lastClean = 0;
  configure(maxBytes: number, ttl: number) {
    this.maxBytes = maxBytes;
    this.ttl = ttl;
    this.lastClean = 0;
  }
  async clear() {
    await this.mutex.run(async () => {
      await rm(this.root, { recursive: true, force: true });
      await mkdir(this.root, { recursive: true });
      this.lastClean = Date.now();
    });
  }
  constructor(
    private root: string,
    private maxBytes: number,
    private ttl: number,
  ) {}
  async get(fileId: string, key: string): Promise<ImageResult | null> {
    return this.mutex.run(async () => {
      const dir = join(this.root, fileId, key);
      try {
        const meta = JSON.parse(
          await readFile(join(dir, "meta.json"), "utf8"),
        ) as { created: number; metadata: Metadata; cacheIdentity?: string };
        if (meta.created + this.ttl < Date.now()) {
          await rm(dir, { recursive: true, force: true });
          return null;
        }
        return {
          metadata: meta.metadata,
          cacheIdentity: meta.cacheIdentity,
          bytes: new Uint8Array(await readFile(join(dir, "image"))),
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    });
  }
  async put(fileId: string, key: string, result: ImageResult) {
    await this.mutex.run(async () => {
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
        await rename(temp, join(parent, key));
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    });
    await this.clean(false);
  }
  async remove(fileId: string) {
    await this.mutex.run(() =>
      rm(join(this.root, fileId), { recursive: true, force: true }),
    );
  }
  async clean(force = true) {
    await this.mutex.run(async () => {
      if (!force && Date.now() - this.lastClean < 300_000) return;
      await mkdir(this.root, { recursive: true });
      const entries: Array<{ path: string; size: number; time: number }> = [];
      for (const f of await readdir(this.root, { withFileTypes: true })) {
        if (!f.isDirectory() || f.isSymbolicLink()) continue;
        for (const k of await readdir(join(this.root, f.name), {
          withFileTypes: true,
        })) {
          if (!k.isDirectory() || k.isSymbolicLink()) continue;
          const path = join(this.root, f.name, k.name);
          if (k.name.startsWith(".tmp-")) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
          try {
            const s = await stat(join(path, "image"));
            if (s.mtimeMs + this.ttl < Date.now())
              await rm(path, { recursive: true, force: true });
            else entries.push({ path, size: s.size, time: s.mtimeMs });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
      }
      let size = entries.reduce((n, x) => n + x.size, 0);
      for (const e of entries.sort((a, b) => a.time - b.time)) {
        if (size <= this.maxBytes) break;
        await rm(e.path, { recursive: true, force: true });
        size -= e.size;
      }
      this.lastClean = Date.now();
    });
  }
}
