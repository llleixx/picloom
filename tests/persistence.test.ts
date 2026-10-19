import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLite } from "../src/persistence/sqlite/store";
import { persistenceContract } from "./persistence.contract";
persistenceContract("SQLite adapter contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "star-db-"));
  const db = await openSQLite(join(root, "db.sqlite"));
  return {
    db,
    async close() {
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
});

test("SQLite open then close permits reopening without repository calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "star-db-lifecycle-"));
  try {
    const path = join(root, "db.sqlite");
    await (await openSQLite(path)).close();
    const db = await openSQLite(path);
    try {
      expect(await db.read((r) => r.userCount())).toBe(0);
    } finally {
      await db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite upgrades an existing database with the storage-key index and reopens safely", async () => {
  const { Database } = await import("bun:sqlite");
  const root = await mkdtemp(join(tmpdir(), "picloom-storage-index-"));
  const path = join(root, "db.sqlite");
  try {
    await (await openSQLite(path)).close();
    const old = new Database(path);
    try {
      old.exec(
        "DROP INDEX file_storage_key; DELETE FROM schema_migrations WHERE version=4;",
      );
    } finally {
      old.close();
    }
    await (await openSQLite(path)).close();
    await (await openSQLite(path)).close();
    const upgraded = new Database(path, { readonly: true });
    try {
      expect(
        upgraded
          .query("SELECT name FROM pragma_index_info('file_storage_key')")
          .all(),
      ).toEqual([{ name: "storage_key" }]);
      expect(
        upgraded
          .query(
            "SELECT count(*) AS count FROM schema_migrations WHERE version=4",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
