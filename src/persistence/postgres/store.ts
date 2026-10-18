import { publicPath, publicPathKey } from "../../infra/files";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Pool, types } from "pg";
import { Kysely, PostgresDialect, CompiledQuery } from "kysely";
import { AppError } from "../../core/errors";
import { SqlStore } from "../store";
import type { Schema } from "../repositories";
import { integer } from "../values";
export async function openPostgres(
  connectionString: string,
): Promise<SqlStore> {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10000,
    types: {
      getTypeParser(oid: number, format?: "text" | "binary") {
        return oid === 20 && format !== "binary"
          ? integer
          : types.getTypeParser(oid, format);
      },
    },
  });
  pool.on("error", () =>
    console.error(
      JSON.stringify({
        event: "database_connection_error",
        database: "postgres",
      }),
    ),
  );
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version BIGINT PRIMARY KEY,checksum TEXT NOT NULL,applied_at BIGINT NOT NULL)",
      );
      for (const [version, name] of [
        [1, "./001_initial.sql"],
        [2, "../002_manual_retry.sql"],
        [3, "../003_public_path.sql"],
      ] as const) {
        const migration = readFileSync(new URL(name, import.meta.url), "utf8");
        const checksum = createHash("sha256").update(migration).digest("hex");
        const { rows } = await client.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [version],
        );
        if (rows[0] && rows[0].checksum !== checksum)
          throw new AppError(
            "MIGRATION_MISMATCH",
            "Migration checksum changed",
            500,
          );
        if (!rows.length) {
          await client.query(migration);
          if (version === 3) {
            const { rows } = await client.query<{
              id: string;
              public_prefix: string;
              logical_key: string;
            }>("SELECT id, public_prefix, logical_key FROM files");
            for (const row of rows)
              await client.query(
                "UPDATE files SET public_path=$1 WHERE id=$2",
                [
                  publicPathKey(publicPath(row.public_prefix, row.logical_key)),
                  row.id,
                ],
              );
          }
          await client.query("INSERT INTO schema_migrations VALUES($1,$2,$3)", [
            version,
            checksum,
            Date.now(),
          ]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
    await db.executeQuery(CompiledQuery.raw("SELECT 1"));
    return new SqlStore(db, "postgres");
  } catch (error) {
    await pool.end();
    throw error;
  }
}
