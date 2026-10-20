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
