import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";
import { bootstrap, initializeDevelopment } from "../src/bootstrap";
import { handler } from "../src/http/app";
import { PluginError } from "../src/plugins/api";
test("HTTP upload, transform, cache, restart and durable deletion", async () => {
  const f = await fixture();
  try {
    expect(await initializeDevelopment(f.app)).toBe(f.profileId);
    const response = await f.upload();
    expect(response.status).toBe(201);
    const value = await response.json();
    const path = new URL(value.url).pathname;
    expect(new Uint8Array(await (await f.request(path)).arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
    const transformed = await f.request(path + "?w=10&format=webp");
    expect(transformed.status).toBe(200);
    const bytes = await transformed.arrayBuffer();
    expect((await sharp(Buffer.from(bytes)).metadata()).width).toBe(10);
    const entries = await readdir(join(f.root, "cache", value.id));
    expect(entries).toHaveLength(1);
    expect(
      new Uint8Array(
        await (await f.request(path + "?format=webp&w=10")).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array(bytes));
    await f.restart();
    expect((await f.request("/api/auth/session")).status).toBe(200);
    const reopened = await f.request(path);
    expect(reopened.status).toBe(200);
    await reopened.arrayBuffer();
    // Consume public bodies so stream references finish before shutdown/deletion.
    await (await f.request(path)).arrayBuffer();
    expect((await f.request("/api/files/" + value.id, "DELETE")).status).toBe(
      202,
    );
    expect((await f.request(path)).status).toBe(404);
    await f.app.files.sweep();
    const row = await f.app.db.read((r) => r.file(value.id));
    expect(row?.status).toBe("deleted");
    expect(row?.temp_status).toBe("cleaned");
    expect(
      (await f.app.db.read((r) => r.tasks(value.id))).find(
        (t) => t.kind === "delete",
      )?.status,
    ).toBe("success");
  } finally {
    await f.close();
  }
}, 20000);
test("authentication, CSRF, upload tokens, revocation and parameter validation", async () => {
  const f = await fixture();
  try {
    const h = handler(f.app);
    expect((await h(new Request("http://localhost/api/files"))).status).toBe(
      401,
    );
    expect(
      (
        await h(
          new Request("http://localhost/api/tokens", {
            method: "POST",
            headers: { cookie: f.cookie, "content-type": "application/json" },
            body: '{"name":"bad"}',
          }),
        )
      ).status,
    ).toBe(403);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request("/api/files", "GET", undefined, token.token)).status,
    ).toBe(403);
    const upload = await f.upload(token.token);
    expect(upload.status).toBe(201);
    const path = new URL((await upload.json()).url).pathname;
    expect((await f.request(path + "?w=90000")).status).toBe(400);
    expect((await f.request(path + "?w=2&w=3")).status).toBe(400);
    expect((await f.request(path + "?format=jpeg")).status).toBe(422);
    expect((await f.request("/i/%2e%2e%2fsecret")).status).toBe(400);
    await f.request("/api/tokens/" + token.id, "DELETE");
    expect((await f.upload(token.token)).status).toBe(401);
    expect(
      (
        await f.request("/api/auth/password", "POST", {
          oldPassword: "test-password-123",
          password: "next-password-123",
        })
      ).status,
    ).toBe(200);
    expect((await f.request("/api/auth/session")).status).toBe(401);
  } finally {
    await f.close();
  }
}, 20000);
test("SVG stored without transformation and invalid uploads do not publish", async () => {
  const f = await fixture();
  try {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    );
    const response = await f.upload(undefined, svg, "test.svg");
    expect(response.status).toBe(201);
    const path = new URL((await response.json()).url).pathname;
    expect(await (await f.request(path)).text()).toBe(
      new TextDecoder().decode(svg),
    );
    expect((await f.request(path + "?w=5")).status).toBe(422);
    expect(
      (await f.upload(undefined, new TextEncoder().encode("not an image")))
        .status,
    ).toBe(415);
    expect(
      (await f.app.db.read((r) => r.filesInStates(["ready"]))).length,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
test("write completed but publication failed is cleaned after restart", async () => {
  const f = await fixture({
    beforePublish: async () => {
      throw new Error("injected");
    },
  });
  try {
    expect((await f.upload()).status).toBe(500);
    const rows = await f.app.db.read((r) => r.filesInStates(["failed"]));
    expect(rows).toHaveLength(1);
    expect(
      (await f.app.db.read((r) => r.replicas(rows[0]!.id)))[0]?.status,
    ).toBe("ready");
    await f.restart();
    expect((await f.app.db.read((r) => r.file(rows[0]!.id)))?.status).toBe(
      "failed",
    );
  } finally {
    await f.close();
  }
});
test("failed deletion remains pending and succeeds on retry", async () => {
  let fail = true;
  const f = await fixture({
    beforeDelete: async () => {
      if (fail) throw new PluginError("NETWORK", "Transient", true);
    },
  });
  try {
    const value = await (await f.upload()).json();
    await f.app.files.delete(value.id);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(value.id)))?.status).toBe(
      "deleting",
    );
    expect(
      (await f.app.db.read((r) => r.tasks(value.id))).find(
        (t) => t.kind === "delete",
      )?.status,
    ).toBe("pending");
    fail = false;
    await f.app.db.transaction(async (r) => {
      const t = (await r.tasks(value.id)).find((t) => t.kind === "delete")!;
      t.next_run_at = 0;
      await r.saveTask(t);
    });
    await f.restart();
    expect((await f.app.db.read((r) => r.file(value.id)))?.status).toBe(
      "deleted",
    );
  } finally {
    await f.close();
  }
});
test("work directory refuses a second live service", async () => {
  const f = await fixture();
  try {
    await expect(bootstrap(f.overrides)).rejects.toThrow("already in use");
  } finally {
    await f.close();
  }
});
