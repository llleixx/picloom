import type { TemporarySpace } from "../infra/temporary-space";
import type { Settings } from "../config";
import type { FileRecord, Persistence } from "../persistence/port";
import type { ImageCache, ImageResult, CachedImage } from "./cache";
import { cacheKey } from "./cache";
import type { Limiter } from "./concurrency";
import { identify, thumbnail } from "../infra/images";

/** Shared execution lifecycle for thumbnails and access transforms. */
export class DerivedImages {
  private merged = new Map<string, Promise<ImageResult | null>>();
  constructor(
    private db: Persistence,
    private config: Settings,
    private cache: ImageCache,
    private limit: Limiter,
    private temporary: TemporarySpace,
    private source: {
      ready(id: string): Promise<FileRecord>;
      read(
        file: FileRecord,
        signal: AbortSignal,
      ): Promise<ReadableStream<Uint8Array>>;
    },
  ) {}
  private metadataMissing(file: FileRecord) {
    return (
      file.mime_type === null ||
      file.byte_size === null ||
      file.width === null ||
      file.height === null
    );
  }
  async identifyOriginal(file: FileRecord, path: string) {
    const metadata = await identify(path, this.config.maxPixels);
    if (this.metadataMissing(file)) {
      try {
        await this.db.transaction((r) =>
          r.fillFileMetadata(file.id, {
            mime_type: metadata.mimeType,
            byte_size: metadata.byteSize,
            width: metadata.width,
            height: metadata.height,
          }),
        );
      } catch {
        console.warn(
          JSON.stringify({
            event: "metadata_backfill_failed",
            fileId: file.id,
          }),
        );
      }
    }
    return metadata;
  }
  async thumbnail(file: FileRecord) {
    const edge = Math.min(
      480,
      this.config.maxDimension,
      Math.floor(Math.sqrt(this.config.maxPixels)),
    );
    const key = await cacheKey(
      file.id,
      { thumbnail: 1, edge, maxPixels: this.config.maxPixels },
      [],
    );
    return (await this.render(
      file,
      key,
      true,
      new AbortController().signal,
      async (getSource) => {
        const source = await getSource();
        if (this.metadataMissing(file)) {
          try {
            await this.identifyOriginal(file, source);
          } catch {
            /* Optional enrichment; first-frame thumbnails can still succeed. */
          }
        }
        return thumbnail(source, this.config.maxPixels, edge);
      },
    ))!;
  }
  async render(
    file: FileRecord,
    key: string,
    cacheable: boolean,
    signal: AbortSignal,
    process: (
      getSource: () => Promise<string>,
      signal: AbortSignal,
      owned: Set<string>,
    ) => Promise<ImageResult | null>,
  ): Promise<ImageResult | CachedImage | null> {
    const cached = cacheable ? await this.cache.get(file.id, key) : null;
    if (cached) {
      try {
        await this.source.ready(file.id);
        return cached;
      } catch (error) {
        await cached.stream.cancel();
        throw error;
      }
    }
    const combined = file.id + ":" + key;
    let pending = cacheable ? this.merged.get(combined) : undefined;
    if (!pending) {
      // One cancelled consumer must not interrupt work shared by others.
      const processingSignal = cacheable
        ? AbortSignal.timeout(120_000)
        : AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      pending = this.limit.run(async () => {
        await this.source.ready(file.id);
        const source = this.temporary.create();
        const owned = new Set([source]);
        try {
          let loading: Promise<string> | undefined;
          const getSource = () =>
            (loading ??= (async () => {
              await this.temporary.write(
                source,
                await this.source.read(file, processingSignal),
                file.byte_size ?? this.config.uploadTempBytes,
                processingSignal,
              );
              return source;
            })());
          let processed: ImageResult | null;
          try {
            processed = await process(getSource, processingSignal, owned);
          } finally {
            // A plugin must await getFile; still finish cleanup if it did not.
            if (loading) await loading.catch(() => {});
          }
          if (!processed) return null;
          const result = {
            ...processed,
            cacheIdentity: crypto.randomUUID(),
          };
          await this.source.ready(file.id);
          if (cacheable) {
            await this.cache.put(file.id, key, result);
            try {
              await this.source.ready(file.id);
            } catch (error) {
              await this.cache.remove(file.id);
              throw error;
            }
          }
          return result;
        } finally {
          await Promise.allSettled(
            [...owned].map((path) => this.temporary.remove(path)),
          );
        }
      });
      if (cacheable) {
        this.merged.set(combined, pending);
        void pending
          .finally(() => this.merged.delete(combined))
          .catch(() => {});
      }
    }
    const result = await pending;
    await this.source.ready(file.id);
    return result;
  }
}
