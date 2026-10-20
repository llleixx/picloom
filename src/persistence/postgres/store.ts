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
        "CREATE TABLE IF NOT EXISTS schema_info(id BIGINT PRIMARY KEY CHECK(id=1),checksum TEXT NOT NULL)",
      );
      const sql = readFileSync(
        new URL("./001_initial.sql", import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const { rows } = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_info WHERE id=1",
      );
      if (rows[0] && rows[0].checksum !== checksum)
        throw new AppError(
          "SCHEMA_MISMATCH",
          "Database schema does not match",
          500,
        );
      if (!rows.length) {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_info(id,checksum) VALUES(1,$1)",
          [checksum],
        );
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
