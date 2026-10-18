import { isDeepStrictEqual } from "node:util";
import type { Persistence } from "../persistence/port";
import { entity } from "../persistence/port";
import type { PluginManager } from "../plugins/manager";
import type { Context, Locator } from "../plugins/api";
import { AppError } from "./errors";
import { logicalKey, prefix, publicPath, publicPathKey } from "../infra/files";
import {
  imageMimeFromKey,
  importMimeTypes,
  type ImportResult,
} from "../../shared/import";

export class Imports {
  constructor(
    private db: Persistence,
    private plugins: PluginManager,
  ) {}
  async page(
    sourceId: string,
    input: Record<string, unknown>,
    ownerId: string,
    ctx: Context,
  ): Promise<ImportResult> {
    if (
      typeof input.publicPrefix !== "string" ||
      (input.scope !== undefined &&
        (typeof input.scope !== "string" || input.scope.length > 2048)) ||
      (input.cursor !== undefined &&
        (typeof input.cursor !== "string" || input.cursor.length > 32768)) ||
      !Array.isArray(input.mimeTypes) ||
      !input.mimeTypes.length ||
      input.mimeTypes.some(
        (m) => !(importMimeTypes as readonly unknown[]).includes(m),
      )
    )
      throw new AppError("INVALID_INPUT", "Invalid import options");
    if (input.scope) logicalKey((input.scope as string).replace(/\/$/, ""));
    const publicPrefix = prefix(input.publicPrefix);
    const lease = this.plugins.acquire(sourceId, "storage");
    try {
      if (!lease.runtime.listFiles)
        throw new AppError(
          "IMPORT_UNSUPPORTED",
          "This storage source cannot enumerate files",
        );
      const page = await lease.runtime.listFiles(
        {
          scope: input.scope as string | undefined,
          cursor: input.cursor as string | undefined,
          limit: 200,
        },
        ctx,
      );
      if (
        !page ||
        !Array.isArray(page.items) ||
        page.items.length > 1000 ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" ||
            !page.nextCursor ||
            page.nextCursor.length > 32768 ||
            page.nextCursor === input.cursor))
      )
        throw new AppError("PLUGIN_RESULT", "Invalid enumeration result", 502);
      ctx.signal.throwIfAborted();
      return await this.db.transaction(async (r) => {
        const result: ImportResult = {
          scanned: page.items.length,
          imported: 0,
          skipped: 0,
          conflicts: 0,
          failed: 0,
          issues: [],
          nextCursor: page.nextCursor,
        };
        const issue = (key: string, code: string) => {
          if (result.issues.length < 20)
            result.issues.push({ logicalKey: key, code });
        };
        for (const item of page.items) {
          let key: string;
          let locator: Locator;
          try {
            if (!item || typeof item.storageKey !== "string") throw 0;
            key = logicalKey(item.storageKey);
            locator = item.locator ?? null;
            if (
              (item.byteSize !== undefined &&
                (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0)) ||
              (item.mimeType !== undefined &&
                (typeof item.mimeType !== "string" ||
                  !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType))) ||
              (locator !== null &&
                typeof locator !== "string" &&
                (typeof locator !== "object" || Array.isArray(locator)))
            )
              throw 0;
          } catch {
            result.failed++;
            issue(
              typeof item?.storageKey === "string"
                ? item.storageKey.slice(0, 2048)
                : "",
              "INVALID_ENTRY",
            );
            continue;
          }
          const mime = item.mimeType ?? imageMimeFromKey(key);
          if (!(input.mimeTypes as string[]).includes(mime ?? "")) {
            result.skipped++;
            continue;
          }
          const existing = await r.fileByPath(
            publicPathKey(publicPath(publicPrefix, key)),
          );
          if (existing) {
            const same =
              existing.status === "ready" &&
              existing.storage_key === key &&
              (await r.replicas(existing.id)).some(
                (rep) =>
                  rep.storage_instance_id === sourceId &&
                  rep.status === "ready" &&
                  isDeepStrictEqual(rep.locator_json, locator),
              );
            if (same) result.skipped++;
            else {
              result.conflicts++;
              issue(key, "PATH_CONFLICT");
            }
            continue;
          }
          if (await r.objectRegistered(sourceId, key, locator)) {
            result.skipped++;
            continue;
          }
          const file = {
            ...entity(),
            guest_ip: null,
            owner_id: ownerId,
            upload_profile_id: null,
            storage_group_id: null,
            public_prefix: publicPrefix,
            logical_key: key,
            storage_key: key,
            mime_type: item.mimeType ?? null,
            byte_size: item.byteSize ?? null,
            width: null,
            height: null,
            status: "ready" as const,
            temp_path: null,
            temp_status: "cleaned" as const,
            last_error: null,
            deleted_at: null,
            processing_results_json: null,
          };
          if (!(await r.insertFileIfPathFree(file))) {
            result.conflicts++;
            issue(key, "PATH_CONFLICT");
            continue;
          }
          await r.insertReplica({
            ...entity(),
            file_id: file.id,
            storage_instance_id: sourceId,
            role: "primary",
            status: "ready",
            locator_json: locator,
          });
          result.imported++;
        }
        return result;
      });
    } finally {
      await lease.release();
    }
  }
}
