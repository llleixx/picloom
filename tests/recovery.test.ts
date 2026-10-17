import { test, expect } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { PluginError } from "../src/plugins/api";
test("actual process exit after storage commit recovers without publishing", async () => {
  const f = await fixture();
  try {
    await f.app.close();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "crash-worker.ts")],
      {
        env: { ...process.env, TEST_ROOT: f.root },
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
    expect(rows[0]!.status).toBe("deleted");
    const replicas = await f.app.db.read((r) => r.replicas(rows[0]!.id));
    expect(replicas[0]!.status).toBe("deleted");
  } finally {
    await f.close();
  }
}, 15000);
test("failure before write creates no public object and can be cleaned", async () => {
  const f = await fixture({
    beforeWrite: async () => {
      throw new PluginError("OFFLINE", "Before write", false, "notApplied");
    },
  });
  try {
    expect((await f.upload()).status).toBe(502);
    await f.app.files.sweep();
    const rows = await f.app.db.read((r) => r.files(10, 0));
    expect(rows[0]!.status).toBe("deleted");
    expect(
      (await f.app.db.read((r) => r.replicas(rows[0]!.id)))[0]!.status,
    ).toBe("cancelled");
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
