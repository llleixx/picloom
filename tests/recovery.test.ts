import { test, expect } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { PluginError } from "../src/plugins/api";
test("process exit after storage commit enters deletion failure until the replica is marked deleted", async () => {
  const f = await fixture();
  try {
    await f.app.close();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "crash-worker.ts")],
      {
        env: {
          ...process.env,
          TEST_ROOT: f.root,
          DATABASE_URL: f.overrides.databaseUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(23);
    await f.restart();
    const rows = await f.app.db.read((r) => r.files(10, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("delete_failed");
    const replicas = await f.app.db.read((r) => r.replicas(rows[0]!.id));
    const replica = replicas[0]!;
    expect(replica.status).toBe("delete_failed");
    expect(replica.locator_json).toBeNull();
    const object = Bun.file(join(f.root, "originals", rows[0]!.storage_key));
    expect(await object.exists()).toBe(true);
    const deletion = (await f.app.db.read((r) => r.tasks(rows[0]!.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(deletion).toMatchObject({ status: "failed", attempts: 1 });
    await f.app.files.terminateReplica(rows[0]!.id, replica.id);
    expect(await f.app.db.read((r) => r.file(rows[0]!.id))).toMatchObject({
      status: "deleted",
    });
    expect(await f.app.db.read((r) => r.task(deletion.id))).toEqual(deletion);
    expect(await object.exists()).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);
test("failed upload cleanup finishes when the remaining replica is marked deleted", async () => {
  const f = await fixture({
    beforeWrite: async () => {
      throw new PluginError("NETWORK", "Before write", false);
    },
    beforeDelete: async () => {
      throw new PluginError("ACCESS_DENIED", "Denied", false);
    },
  });
  try {
    expect((await f.upload()).status).toBe(502);
    await f.app.files.sweep();
    const rows = await f.app.db.read((r) => r.files(10, 0));
    expect(rows[0]!.status).toBe("delete_failed");
    expect(
      await f.app.db.read((r) => r.countFiles({ status: "attention" })),
    ).toBe(1);
    const replica = (await f.app.db.read((r) => r.replicas(rows[0]!.id)))[0]!;
    expect(replica.status).toBe("delete_failed");
    const failedDelete = (
      await f.app.db.read((r) => r.tasks(rows[0]!.id))
    ).find((t) => t.kind === "delete")!;
    expect(failedDelete.status).toBe("failed");
    expect(
      await f.app.db.read((r) =>
        r.storageUsedBytes(replica.storage_instance_id),
      ),
    ).toBe(f.png.length);
    await f.app.files.terminateReplica(rows[0]!.id, replica.id);
    expect((await f.app.db.read((r) => r.file(rows[0]!.id)))?.status).toBe(
      "deleted",
    );
    expect(await f.app.db.read((r) => r.task(failedDelete.id))).toEqual(
      failedDelete,
    );
    expect(
      await f.app.db.read((r) => r.countFiles({ status: "attention" })),
    ).toBe(0);
  } finally {
    await f.close();
  }
});
test("delete racing with upload prevents publication and retains cleanup locator", async () => {
  let started!: () => void, release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const written = new Promise<void>((r) => (started = r));
  const f = await fixture({
    afterWrite: async () => {
      started();
      await gate;
    },
  });
  try {
    const pending = f.upload();
    await written;
    const file = (
      await f.app.db.read((r) => r.filesInStates(["preparing"]))
    )[0]!;
    await f.app.files.delete(file.id);
    release();
    expect((await pending).status).toBe(409);
    await f.app.files.tasks.drain();
    expect(
      (await f.app.db.read((r) => r.tasks(file.id))).find(
        (task) => task.kind === "write",
      ),
    ).toMatchObject({
      status: "success",
      attempts: 1,
      last_error: null,
      next_run_at: null,
    });
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(file.id)))!.status).toBe(
      "deleted",
    );
  } finally {
    release();
    await f.close();
  }
});
test("real Bun HTTP listener handles request upload limit", async () => {
  const f = await fixture();
  const handle = handler(f.app);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1024,
    fetch(req) {
      return handle(req);
    },
  });
  try {
    const response = await fetch(new URL("/api/auth/login", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "test-password-123",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await response.arrayBuffer();
    const oversized = await fetch(new URL("/api/files", server.url), {
      method: "POST",
      body: "x".repeat(2048),
    });
    expect(oversized.status).toBe(413);
    await oversized.arrayBuffer();
  } finally {
    await server.stop(true);
    await f.close();
  }
});
