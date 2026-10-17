import { Pool } from "pg";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPostgres } from "../src/persistence/postgres/store";
import { persistenceContract } from "./persistence.contract";
import { fixture } from "./helpers";
import { startRuntime } from "../src/runtime";
import { entity } from "../src/persistence/port";
const connectionString = process.env.TEST_POSTGRES_URL;
import { isolatedPostgres } from "./postgres-fixture";
const isolated = () => isolatedPostgres(connectionString!);
if (process.env.REQUIRE_POSTGRES_TEST === "1" && !connectionString)
  throw new Error("TEST_POSTGRES_URL is required for test:postgres");
if (connectionString) {
  test("PostgreSQL immediate close and migration failure release their pools", async () => {
    const scope = await isolated();
    const monitor = new Pool({ connectionString });
    const url = new URL(scope.url);
    const name = "lifecycle-" + crypto.randomUUID();
    url.searchParams.set("application_name", name);
    try {
      const db = await openPostgres(url.toString());
      await db.close();
      const result = await monitor.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1",
        [name],
      );
      expect(result.rows[0].n).toBe(0);
      const setup = new Pool({ connectionString: scope.url });
      try {
        await setup.query("UPDATE schema_migrations SET checksum='invalid'");
      } finally {
        await setup.end();
      }
      await expect(openPostgres(url.toString())).rejects.toThrow(
        "Migration checksum changed",
      );
      const afterFailure = await monitor.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1",
        [name],
      );
      expect(afterFailure.rows[0].n).toBe(0);
    } finally {
      await monitor.end();
      await scope.close();
    }
  });

  persistenceContract("PostgreSQL adapter contract", async () => {
    const scope = await isolated();
    try {
      const db = await openPostgres(scope.url);
      return {
        db,
        async close() {
          await db.close();
          await scope.close();
        },
      };
    } catch (e) {
      await scope.close();
      throw e;
    }
  });
  test("PostgreSQL HTTP login, upload, processing, restart and delete", async () => {
    const scope = await isolated();
    const f = await fixture({}, scope.url);
    try {
      const uploaded = await f.upload();
      expect(uploaded.status).toBe(201);
      const file = await uploaded.json();
      const path = new URL(file.url).pathname;
      const original = await f.request(path);
      expect(original.status).toBe(200);
      expect((await original.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const transformed = await f.request(path + "?w=10");
      expect(transformed.status).toBe(200);
      await transformed.arrayBuffer();
      await f.restart();
      expect((await f.request("/api/auth/session")).status).toBe(200);
      const list = await f.request("/api/files?status=ready");
      expect(list.headers.get("x-total-count")).toBe("1");
      expect((await list.json())[0].id).toBe(file.id);
      expect((await f.request("/api/files/" + file.id, "DELETE")).status).toBe(
        202,
      );
      await f.app.files.sweep();
      expect((await f.app.db.read((r) => r.file(file.id)))?.status).toBe(
        "deleted",
      );
      expect((await f.request(path)).status).toBe(404);
    } finally {
      await f.close();
      await scope.close();
    }
  }, 30000);
  test("PostgreSQL read scopes retain a snapshot and versions reject concurrent writes", async () => {
    const scope = await isolated(),
      db = await openPostgres(scope.url);
    try {
      const user = {
        ...entity(),
        username: "snapshot",
        password_hash: "hash",
        role: "member" as const,
        status: "active" as const,
        max_upload_bytes: null,
        daily_upload_limit: null,
        auth_version: 1,
      };
      await db.transaction((r) => r.insertUser(user));
      await db.read(async (r) => {
        expect(await r.userCount()).toBe(1);
        await db.transaction((w) =>
          w.insertUser({ ...user, ...entity(), username: "second" }),
        );
        expect(await r.userCount()).toBe(1);
      });
      const outcomes = await Promise.allSettled([
        db.transaction((r) => r.changePassword(user.id, 1, "one")),
        db.transaction((r) => r.changePassword(user.id, 1, "two")),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    } finally {
      await db.close();
      await scope.close();
    }
  });
  test("PostgreSQL serialization retries database work without losing concurrent increments", async () => {
    const scope = await isolated(),
      db = await openPostgres(scope.url);
    try {
      const user = {
        ...entity(),
        username: "counter",
        password_hash: "hash",
        role: "member" as const,
        status: "active" as const,
        max_upload_bytes: null,
        daily_upload_limit: null,
        auth_version: 1,
      };
      await db.transaction((r) => r.insertUser(user));
      let entered = 0,
        release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const increment = () => {
        let first = true;
        return db.transaction(async (r) => {
          const current = (await r.user(user.id))!;
          if (first) {
            first = false;
            if (++entered === 2) release();
            await gate;
          }
          await r.changePassword(user.id, current.auth_version, "changed");
        });
      };
      await Promise.all([increment(), increment()]);
      expect((await db.read((r) => r.user(user.id)))?.auth_version).toBe(3);
    } finally {
      await db.close();
      await scope.close();
    }
  });
  test("PostgreSQL runtime advertises database and rejects all backup routes", async () => {
    const scope = await isolated(),
      root = await mkdtemp(join(tmpdir(), "star-pg-runtime-"));
    const runtime = await startRuntime(
      {
        root,
        databaseUrl: scope.url,
        encryptionKey: "ab".repeat(32),
        origin: "http://localhost",
        secureCookie: false,
      },
      { initialPassword: "test-password-123", sweep: false },
    );
    try {
      const login = await runtime.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "admin",
            password: "test-password-123",
          }),
        }),
      );
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      await login.arrayBuffer();
      const session = await (
        await runtime.fetch(
          new Request("http://localhost/api/auth/session", {
            headers: { cookie },
          }),
        )
      ).json();
      const headers = { cookie, "x-csrf-token": session.csrfToken };
      const status = await (
        await runtime.fetch(
          new Request("http://localhost/api/system/status", { headers }),
        )
      ).json();
      expect(status.database).toBe("postgres");
      for (const [method, path] of [
        ["GET", ""],
        ["POST", ""],
        ["POST", "/upload"],
        ["GET", "/test"],
        ["DELETE", "/test"],
        ["POST", "/test/restore"],
      ]) {
        const response = await runtime.fetch(
          new Request("http://localhost/api/system/backups" + path, {
            method,
            headers,
          }),
        );
        expect(response.status).toBe(400);
        expect(JSON.stringify(await response.json())).toContain(
          "BACKUP_UNSUPPORTED",
        );
      }
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
      await scope.close();
    }
  }, 30000);
} else test.skip("PostgreSQL integration (set TEST_POSTGRES_URL)", () => {});
