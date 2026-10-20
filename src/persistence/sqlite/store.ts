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
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS schema_info(id INTEGER PRIMARY KEY CHECK(id=1),checksum TEXT NOT NULL)",
      );
      const sql = readFileSync(
        new URL("./001_initial.sql", import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = db
        .query("SELECT checksum FROM schema_info WHERE id=1")
        .get() as { checksum: string } | null;
      if (existing && existing.checksum !== checksum)
        throw new AppError(
          "SCHEMA_MISMATCH",
          "Database schema does not match",
          500,
        );
      if (!existing) {
        db.exec(sql);
        db.query("INSERT INTO schema_info(id,checksum) VALUES(1,?)").run(
          checksum,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
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
