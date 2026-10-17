import { test, expect } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, extract } from "tar";
import { startRuntime } from "../src/runtime";
import { initializeDevelopment } from "../src/bootstrap";
import { Secrets } from "../src/infra/secrets";
import { workLock } from "../src/infra/files";
import { externalBuiltin } from "./package-fixtures";
const password = "test-password-123";
async function setup(parent: string, name = "data", key = "ab".repeat(32)) {
  const root = join(parent, name);
  const runtime = await startRuntime(
    {
      root,
      encryptionKey: key,
      origin: "http://localhost",
      secureCookie: false,
    },
    { initialPassword: password, sweep: false },
  );
  let cookie = "",
    csrf = "";
  async function request(
    path: string,
    method = "GET",
    value?: unknown,
    extra: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = {
      cookie,
      "x-csrf-token": csrf,
      ...extra,
    };
    let body: BodyInit | undefined;
    if (value instanceof FormData || value instanceof Blob) body = value;
    else if (value !== undefined) {
      body = JSON.stringify(value);
      headers["content-type"] = "application/json";
    }
    const response = await runtime.fetch(
      new Request("http://localhost" + path, { method, headers, body }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      json: () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }
  async function login(name = "admin", pass = password) {
    const result = await request("/api/auth/login", "POST", {
      username: name,
      password: pass,
    });
    expect(result.status).toBe(200);
    cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    csrf = (await request("/api/auth/session")).json().csrfToken;
  }
  await login();
  return { root, runtime, request, login, key };
}
test("first startup creates Owner once and only prints generated passwords", async () => {
  const parent = await mkdtemp(join(tmpdir(), "star-owner-")),
    root = join(parent, "data");
  const messages: string[] = [];
  const config = {
    root,
    encryptionKey: "ab".repeat(32),
    origin: "http://localhost",
  };
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime(config, {
      initialPassword: "",
      log: (s) => messages.push(s),
      sweep: false,
    });
    expect(messages).toHaveLength(1);
    const generated = messages[0]!.match(
      /Initial password: ([A-Za-z0-9_-]+)/,
    )![1]!;
    expect(generated.length).toBe(32);
    expect(
      (await runtime.app.auth.login("admin", generated, "test")).user.role,
    ).toBe("owner");
    await runtime.close();
    runtime = await startRuntime(config, {
      initialPassword: "short",
      log: (s) => messages.push(s),
      sweep: false,
    });
    expect(messages).toHaveLength(1);
    expect(
      (await runtime.app.auth.login("admin", generated, "test")).user.role,
    ).toBe("owner");
    expect(await runtime.app.db.read((r) => r.userCount())).toBe(1);
  } finally {
    await runtime?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
test("backup restores images, external local roots, settings and encrypted credentials into a new deployment", async () => {
  const parent = await mkdtemp(join(tmpdir(), "star-backup-"));
  const source = await setup(parent);
  let target: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const profile = await initializeDevelopment(source.runtime.app);
    const form = new FormData();
    form.set("profileId", profile);
    form.set(
      "file",
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
        ],
        "test.svg",
        { type: "image/svg+xml" },
      ),
    );
    const uploaded = await source.request("/api/files", "POST", form);
    expect(uploaded.status).toBe(201);
    const image = uploaded.json();
    const external = join(parent, "external");
    await mkdir(external);
    await writeFile(join(external, "sample.txt"), "external original");
    const packageForm = new FormData();
    packageForm.set(
      "file",
      new File(
        [
          new Uint8Array(
            await externalBuiltin(
              "local",
              "localStorage",
              "external.local",
              "storage",
            ),
          ),
        ],
        "local.zip",
      ),
    );
    const inspected = await source.request(
      "/api/plugins/inspect",
      "POST",
      packageForm,
    );
    expect(inspected.status).toBe(200);
    const installed = await source.request("/api/plugins/install", "POST", {
      ticket: inspected.json().ticket,
      confirmTrusted: true,
    });
    expect(installed.status).toBe(201);
    const local = await source.runtime.app.plugins.save({
      pluginId: "external.local",
      version: "1.0.0",
      name: "external",
      config: { root: external },
    });
    const hook = await source.runtime.app.plugins.save({
      pluginId: "builtin.webhook",
      version: "1.0.0",
      name: "secret",
      stage: "post_save",
      config: { url: "https://example.com/hook" },
      secretEdits: { "/token": { action: "replace", value: "kept-secret" } },
    });
    await source.runtime.app.delivery.save({
      ...source.runtime.app.delivery.get(),
      siteName: "Restored site",
    });
    await mkdir(join(source.root, "cache"), { recursive: true });
    await writeFile(join(source.root, "cache", "not-backed-up"), "cache");
    const backup = await source.request("/api/system/backups", "POST");
    expect(backup.status).toBe(201);
    const id = backup.json().id;
    expect((await source.request("/api/auth/session")).status).toBe(200);
    const download = await source.request("/api/system/backups/" + id);
    expect(download.status).toBe(200);
    target = await setup(parent, "target", "cd".repeat(32));
    const added = await target.request(
      "/api/system/backups/upload",
      "POST",
      new Blob([download.bytes]),
    );
    expect(added.status).toBe(201);
    const restore = await target.request(
      `/api/system/backups/${added.json().id}/restore`,
      "POST",
      undefined,
      { "x-confirm-restore": "restore" },
    );
    expect(restore.status).toBe(200);
    expect((await target.request("/api/auth/session")).status).toBe(401);
    await target.login();
    const original = await target.request(new URL(image.url).pathname);
    expect(original.status).toBe(200);
    expect(new TextDecoder().decode(original.bytes)).toContain("<svg");
    expect(target.runtime.app.delivery.get().siteName).toBe("Restored site");
    const restoredLocal = (await target.runtime.app.db.read((r) =>
      r.instance(local.id),
    ))!;
    expect(target.runtime.app.plugins.isReady(local.id)).toBe(true);
    expect(String(restoredLocal.config_json.root)).toStartWith(
      target.root + "/originals/",
    );
    expect(
      await readFile(
        join(String(restoredLocal.config_json.root), "sample.txt"),
        "utf8",
      ),
    ).toBe("external original");
    const restoredHook = (await target.runtime.app.db.read((r) =>
      r.instance(hook.id),
    ))!;
    expect(
      new Secrets(target.key).decrypt(restoredHook.secrets_encrypted, hook.id)
        .token,
    ).toBe("kept-secret");
    expect(
      await Bun.file(join(target.root, "cache", "not-backed-up")).exists(),
    ).toBe(false);
    expect(
      (await readdir(parent)).some((n) =>
        n.startsWith("target.before-restore-"),
      ),
    ).toBe(true);
    await expect(workLock(target.root)).rejects.toThrow("already in use");
    expect(await readFile(join(external, "sample.txt"), "utf8")).toBe(
      "external original",
    );
  } finally {
    await target?.runtime.close();
    await source.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 20000);
test("backup endpoints enforce Owner, session, CSRF, confirmation and reject unsafe archives without changing data", async () => {
  const parent = await mkdtemp(join(tmpdir(), "star-backup-")),
    f = await setup(parent);
  try {
    const unauthorized = await f.request(
      "/api/system/backups",
      "POST",
      undefined,
      { "x-csrf-token": "bad" },
    );
    expect(unauthorized.status).toBe(403);
    const token = (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json().token;
    expect(
      (
        await f.request("/api/system/backups", "GET", undefined, {
          authorization: "Bearer " + token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/api/users", "POST", {
          username: "other",
          password,
          role: "admin",
          status: "active",
          profileIds: [],
        })
      ).status,
    ).toBe(201);
    await f.login("other");
    expect((await f.request("/api/system/backups")).status).toBe(403);
    await f.login();
    expect(
      (
        await f.request(
          "/api/system/backups/upload",
          "POST",
          new Blob(["not an archive"]),
        )
      ).status,
    ).not.toBe(201);
    const backup = (await f.request("/api/system/backups", "POST")).json();
    expect(
      (await f.request(`/api/system/backups/${backup.id}/restore`, "POST"))
        .status,
    ).toBe(400);
    const staging = join(parent, "unsafe");
    await mkdir(staging);
    await writeFile(join(staging, "manifest.json"), "{}");
    const { symlink } = await import("node:fs/promises");
    await symlink("/tmp", join(staging, "data"));
    const tar = join(parent, "unsafe.tar.gz");
    await create({ cwd: staging, file: tar, gzip: true }, [
      "manifest.json",
      "data",
    ]);
    expect(
      (await f.request("/api/system/backups/upload", "POST", Bun.file(tar)))
        .status,
    ).toBe(400);
    expect((await f.request("/api/auth/session")).status).toBe(200);
    const backupPath = `/api/system/backups/${backup.id}`;
    await f.login("other");
    expect((await f.request(backupPath, "DELETE")).status).toBe(403);
    await f.login();
    expect(
      (
        await f.request(backupPath, "DELETE", undefined, {
          "x-csrf-token": "bad",
        })
      ).status,
    ).toBe(403);
    expect((await f.request(backupPath)).status).toBe(200);
    expect(
      (await f.request("/api/system/backups/not-an-archive", "DELETE")).status,
    ).toBe(400);
    expect((await f.request(backupPath, "DELETE")).status).toBe(200);
    expect((await f.request(backupPath, "DELETE")).status).toBe(200);
    expect((await f.request(backupPath)).status).toBe(404);
    expect((await f.request("/api/system/backups")).json()).toEqual([]);
    expect((await f.request("/api/auth/session")).status).toBe(200);
    expect(await f.runtime.app.db.read((r) => r.userCount())).toBe(2);
  } finally {
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 20000);

test("maintenance drains streams and failed restore preserves existing data", async () => {
  const parent = await mkdtemp(join(tmpdir(), "star-backup-")),
    f = await setup(parent);
  try {
    const pending = await f.runtime.fetch(
      new Request("http://localhost/api/client-settings"),
    );
    const backupPromise = f.request("/api/system/backups", "POST");
    let paused = false;
    for (let i = 0; i < 50; i++) {
      const check = await f.request("/api/client-settings");
      if (check.status === 503) {
        paused = true;
        break;
      }
      await Bun.sleep(2);
    }
    expect(paused).toBe(true);
    await pending.arrayBuffer();
    const backup = await backupPromise;
    expect(backup.status).toBe(201);
    const stage = join(parent, "modified");
    await mkdir(stage);
    await extract({
      file: join(f.root + ".backups", backup.json().id),
      cwd: stage,
    });
    await writeFile(join(stage, "data", "delivery-settings.json"), "{}");
    const file = join(parent, "broken-settings.tar.gz");
    await create({ cwd: stage, file, gzip: true }, ["manifest.json", "data"]);
    const uploaded = await f.request(
      "/api/system/backups/upload",
      "POST",
      Bun.file(file),
    );
    expect(uploaded.status).toBe(201);
    expect(
      (
        await f.request(
          `/api/system/backups/${uploaded.json().id}/restore`,
          "POST",
          undefined,
          { "x-confirm-restore": "restore" },
        )
      ).status,
    ).toBe(400);
    expect((await f.request("/api/auth/session")).status).toBe(200);
    expect((await f.request("/api/system/backups")).status).toBe(200);
    await expect(workLock(f.root)).rejects.toThrow("already in use");
  } finally {
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 15000);
