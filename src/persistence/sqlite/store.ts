import { publicPath, publicPathKey } from "../../infra/files";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Kysely, CompiledQuery } from "kysely";
import { BunSqliteDialect } from "kysely-bun-worker/normal";
import { AppError } from "../../core/errors";
import { SqlStore } from "../store";
import type { Schema } from "../repositories";
export async function openSQLite(path: string): Promise<SqlStore> {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)",
    );
    for (const [version, name] of [
      [1, "./001_initial.sql"],
      [2, "../002_manual_retry.sql"],
      [3, "../003_public_path.sql"],
      [4, "../004_storage_key.sql"],
    ] as const) {
      const sql = readFileSync(new URL(name, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = db
        .query("SELECT checksum FROM schema_migrations WHERE version=?")
        .get(version) as { checksum: string } | null;
      if (existing && existing.checksum !== checksum)
        throw new AppError(
          "MIGRATION_MISMATCH",
          "Migration checksum changed",
          500,
        );
      if (!existing) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(sql);
          if (version === 3) {
            const rows = db
              .query("SELECT id, public_prefix, logical_key FROM files")
              .all() as Array<{
              id: string;
              public_prefix: string;
              logical_key: string;
            }>;
            const update = db.query(
              "UPDATE files SET public_path=? WHERE id=?",
            );
            for (const row of rows)
              update.run(
                publicPathKey(publicPath(row.public_prefix, row.logical_key)),
                row.id,
              );
          }
          db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(
            version,
            checksum,
            Date.now(),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  } finally {
    db.close();
  }
  const runtime = new Kysely<Schema>({
    dialect: new BunSqliteDialect({
      url: path,
      cacheStatement: true,
      onCreateConnection: async (c) => {
        await c.executeQuery(CompiledQuery.raw("PRAGMA foreign_keys=ON"));
        await c.executeQuery(CompiledQuery.raw("PRAGMA journal_mode=WAL"));
        await c.executeQuery(CompiledQuery.raw("PRAGMA busy_timeout=5000"));
      },
    }),
  });
  try {
    await runtime.executeQuery(CompiledQuery.raw("SELECT 1"));
    return new SqlStore(runtime, "sqlite");
  } catch (error) {
    await runtime.destroy();
    throw error;
  }
}
