import { themePackage } from "./theme-fixtures";
import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { prepareRestoredDatabase } from "../src/persistence/sqlite/backup";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { create, extract } from "tar";
import { startRuntime } from "../src/runtime";
import { initializeDevelopment } from "../src/bootstrap";
import { Secrets } from "../src/infra/secrets";
import { workLock } from "../src/infra/files";
import { bundledPackage, externalBuiltin } from "./package-fixtures";
const password = "sixsix";
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
    const defaults = await runtime.app.db.read(async (r) => ({
      profiles: await r.profiles(),
      groups: await r.groups(),
      instances: await r.instances(),
      steps: await r.steps((await r.accessPipeline())!.id),
    }));
    expect(defaults.profiles).toHaveLength(1);
    expect(defaults.groups).toHaveLength(1);
    expect(defaults.instances).toHaveLength(2);
    expect(defaults.steps).toHaveLength(0);
    expect(defaults.profiles[0]).toMatchObject({
      name: "Default",
      public_prefix: "/i/",
      enabled: true,
      storage_group_id: defaults.groups[0]!.id,
      upload_pipeline_id: null,
      post_save_pipeline_id: null,
    });
    expect(defaults.groups[0]).toMatchObject({
      name: "Default",
      replica_count: 1,
    });
    expect(defaults.instances.find((x) => x.kind === "storage")).toMatchObject({
      name: "Default",
      plugin_id: "builtin.local",
      config_json: { root: join(root, "images") },
    });
    expect(defaults.instances.find((x) => x.kind === "path")).toMatchObject({
      name: "Default",
      plugin_id: "builtin.random-path",
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
    expect(await runtime.app.db.read((r) => r.profiles())).toEqual(
      defaults.profiles,
    );
    expect(await runtime.app.db.read((r) => r.groups())).toEqual(
      defaults.groups,
    );
    await runtime.app.db.transaction((r) =>
      r.deleteProfile(defaults.profiles[0]!.id),
    );
    await runtime.close();
    runtime = await startRuntime(config, { sweep: false });
    expect(await runtime.app.db.read((r) => r.profiles())).toHaveLength(0);
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
    const fixturePackage = await bundledPackage(
      "test.post-save",
      "processor",
      `import {postSaveFixture} from ${JSON.stringify(new URL("./post-save-fixture.ts", import.meta.url).pathname)}; export default postSaveFixture;`,
    );
    const fixtureTicket =
      await source.runtime.app.packages.inspect(fixturePackage);
    await source.runtime.app.packages.install(fixtureTicket.ticket, true);
    const moderation = await source.runtime.app.plugins.save({
      pluginId: "test.post-save",
      version: "1.0.0",
      name: "secret",
      stage: "post_save",
      config: {},
      secretEdits: {
        "/secretKey": { action: "replace", value: "kept-secret" },
      },
    });
    await source.runtime.app.delivery.save({
      ...source.runtime.app.delivery.get(),
      content: { "en-US": { name: "Restored site" } },
    });
    await mkdir(join(source.root, "cache"), { recursive: true });
    await writeFile(join(source.root, "cache", "not-backed-up"), "cache");
    const theme = await source.runtime.app.themes.inspect(themePackage());
    await source.runtime.app.themes.install(theme.ticket, true);
    await source.runtime.app.themes.activate({
      id: "example.theme",
      version: "1.0.0",
    });
    await source.runtime.app.themes.configure("example.theme", "1.0.0", {
      heading: "Unpublished",
    });
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
    expect(target.runtime.app.themes.active()!.config.heading).toBe("Original");
    expect(
      target.runtime.app.themes.preview("example.theme", "1.0.0").config
        .heading,
    ).toBe("Unpublished");
    expect(
      await Bun.file(
        join(target.root, "themes/example.theme@1.0.0/entry.js"),
      ).exists(),
    ).toBe(true);
    expect((await target.request("/api/auth/session")).status).toBe(401);
    await target.login();
    const original = await target.request(new URL(image.url).pathname);
    expect(original.status).toBe(200);
    expect(new TextDecoder().decode(original.bytes)).toContain("<svg");
    expect(target.runtime.app.delivery.get().content["en-US"]?.name).toBe(
      "Restored site",
    );
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
    const restoredModeration = (await target.runtime.app.db.read((r) =>
      r.instance(moderation.id),
    ))!;
    expect(
      new Secrets(target.key).decrypt(
        restoredModeration.secrets_encrypted,
        moderation.id,
      ).secretKey,
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
test("backup restores retained temporary files and resumes replication retries in a new root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "picloom-backup-retry-"));
  const source = await setup(parent);
  let target: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const app = source.runtime.app;
    const profileId = await initializeDevelopment(app);
    const extra = await app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Replica",
      config: { root: join(source.root, "replica") },
    });
    const profile = await app.configuration.profile(profileId);
    const group = await app.configuration.group(profile.storageGroupId);
    await app.configuration.saveGroup(
      {
        ...group,
        expectedVersion: group.configVersion,
        replicaCount: 2,
        members: [...group.members, { instanceId: extra.id, weight: 1 }],
      },
      group.id,
    );
    const lease = app.plugins.acquire(extra.id, "storage");
    const failure = spyOn(lease.runtime, "write").mockRejectedValue(
      new Error("Temporary storage failure"),
    );
    const content =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    const form = new FormData();
    form.set("profileId", profileId);
    form.set(
      "file",
      new File([content], "test.svg", { type: "image/svg+xml" }),
    );
    let id: string;
    try {
      const uploaded = await source.request("/api/files", "POST", form);
      expect(uploaded.status).toBe(201);
      id = uploaded.json().id;
      await app.files.tasks.drain();
      await app.files.tasks.pause();
    } finally {
      failure.mockRestore();
      await lease.release();
    }
    const replica = (await app.db.read((r) => r.replicas(id))).find(
      (r) => r.storage_instance_id === extra.id,
    )!;
    const task = (await app.db.read((r) => r.tasks(id))).find(
      (t) => t.replica_id === replica.id && t.kind === "write",
    )!;
    const retry = (await app.db.read((r) => r.task(task.id)))!;
    expect(retry).toMatchObject({ status: "pending", attempts: 1 });
    await app.db.transaction((r) =>
      r.saveTask({ ...retry, next_run_at: Date.now() + 3600000 }),
    );
    const file = (await app.db.read((r) => r.file(id)))!;
    expect(file.temp_path).not.toBeNull();
    const tempName = file.temp_path!;
    expect(await readFile(join(source.root, "temp", tempName), "utf8")).toBe(
      content,
    );
    const backup = await source.request("/api/system/backups", "POST");
    expect(backup.status).toBe(201);
    const download = await source.request(
      `/api/system/backups/${backup.json().id}`,
    );
    target = await setup(parent, "target", "cd".repeat(32));
    const added = await target.request(
      "/api/system/backups/upload",
      "POST",
      new Blob([download.bytes]),
    );
    expect(added.status).toBe(201);
    const restored = await target.request(
      `/api/system/backups/${added.json().id}/restore`,
      "POST",
      undefined,
      { "x-confirm-restore": "restore" },
    );
    expect(restored.status).toBe(200);
    const restoredApp = target.runtime.app;
    expect((await restoredApp.db.read((r) => r.file(id)))!.temp_path).toBe(
      tempName,
    );
    expect(await readFile(join(target.root, "temp", tempName), "utf8")).toBe(
      content,
    );
    await restoredApp.db.transaction(async (r) => {
      const pending = (await r.task(task.id))!;
      expect(pending).toMatchObject({ status: "pending", attempts: 1 });
      await r.saveTask({ ...pending, next_run_at: Date.now() });
    });
    await restoredApp.files.sweep();
    expect((await restoredApp.db.read((r) => r.task(task.id)))!.status).toBe(
      "success",
    );
    expect(
      (await restoredApp.db.read((r) => r.replicas(id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
    const storage = (await restoredApp.db.read((r) =>
      r.instance(replica.storage_instance_id),
    ))!;
    expect(
      await readFile(
        join(String(storage.config_json.root), file.storage_key),
        "utf8",
      ),
    ).toBe(content);
    expect(
      (await restoredApp.db.read((r) => r.file(id)))!.temp_path,
    ).toBeNull();
    expect(await Bun.file(join(target.root, "temp", tempName)).exists()).toBe(
      false,
    );
  } finally {
    await target?.runtime.close();
    await source.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("restore rejects temporary paths outside the flat temporary directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "picloom-backup-path-"));
  const f = await setup(parent);
  try {
    const profileId = await initializeDevelopment(f.runtime.app);
    const form = new FormData();
    form.set("profileId", profileId);
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
    const uploaded = await f.request("/api/files", "POST", form);
    expect(uploaded.status).toBe(201);
    await f.runtime.close();
    const path = join(f.root, "database.sqlite");
    for (const name of [
      "",
      ".",
      "..",
      "../outside",
      "/tmp/outside",
      "nested/file",
      "..\\outside",
      "C:\\outside",
    ]) {
      const db = new Database(path);
      try {
        db.query("UPDATE files SET temp_path=? WHERE id=?").run(
          name,
          uploaded.json().id,
        );
      } finally {
        db.close();
      }
      expect(() => prepareRestoredDatabase(path, {}, f.key, f.key)).toThrow();
    }
  } finally {
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

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
      file: join(dirname(f.root), "backups", backup.json().id),
      cwd: stage,
    });
    await writeFile(join(stage, "data", "site-settings.json"), "{}");
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

test("backup Origin checks apply only when site origin is configured", async () => {
  const parent = await mkdtemp(join(tmpdir(), "picloom-backup-origin-"));
  const f = await setup(parent);
  try {
    for (const origin of ["", "https://configured.example"]) {
      f.runtime.app.config.origin = origin;
      const allowed = origin || "http://localhost";
      expect(
        (
          await f.request("/api/system/backups", "GET", undefined, {
            origin: allowed,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.request("/api/system/backups", "GET", undefined, {
            origin: "https://other.example",
          })
        ).status,
      ).toBe(origin ? 403 : 200);
      if (origin) {
        expect(
          (
            await f.request("/api/system/backups", "GET", undefined, {
              origin: "http://localhost",
            })
          ).status,
        ).toBe(403);
      }
    }
  } finally {
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup pauses automatic refill before draining tasks and resumes after preparation failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "picloom-backup-tasks-"));
  const f = await setup(parent);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deletion: ReturnType<typeof spyOn> | undefined;
  let directory: ReturnType<typeof spyOn> | undefined;
  let lease:
    | ReturnType<typeof f.runtime.app.plugins.acquire<"storage">>
    | undefined;
  let backup: ReturnType<typeof f.request> | undefined;
  try {
    const app = f.runtime.app;
    app.config.deleteConcurrency = 1;
    const profile = await initializeDevelopment(app);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
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
      const uploaded = await f.request("/api/files", "POST", form);
      expect(uploaded.status).toBe(201);
      ids.push(uploaded.json().id);
    }
    for (const id of ids) await app.files.delete(id);
    await app.files.tasks.cleanupPending();
    const replica = (await app.db.read((r) => r.replicas(ids[0]!)))[0]!;
    lease = app.plugins.acquire(replica.storage_instance_id, "storage");
    let calls = 0;
    deletion = spyOn(lease.runtime, "delete").mockImplementation(async () => {
      calls++;
      if (calls === 1) await gate;
    });
    directory = spyOn(app.plugins, "localDirectory").mockImplementation(() => {
      expect(calls).toBe(1);
      throw new Error("Backup preparation failed");
    });
    await app.files.tasks.dispatch();
    const deadline = Date.now() + 2000;
    while (calls === 0 && Date.now() < deadline) await Bun.sleep(1);
    expect(calls).toBe(1);
    backup = f.request("/api/system/backups", "POST");
    let paused = false;
    while (Date.now() < deadline) {
      if ((await f.request("/api/client-settings")).status === 503) {
        paused = true;
        break;
      }
      await Bun.sleep(1);
    }
    expect(paused).toBe(true);
    release();
    expect((await backup).status).toBe(500);
    await app.files.tasks.drain();
    expect(calls).toBe(2);
    expect((await f.request("/api/auth/session")).status).toBe(200);
  } finally {
    release();
    await backup;
    await f.runtime.app.files.tasks.drain();
    deletion?.mockRestore();
    directory?.mockRestore();
    await lease?.release();
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("backup lets admitted uploads finish queued first writes before pausing tasks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "picloom-backup-upload-"));
  const f = await setup(parent);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const app = f.runtime.app;
  app.config.writeConcurrency = 1;
  const profile = await initializeDevelopment(app);
  const source = (await app.plugins.storageViews())[0]!;
  const lease = app.plugins.acquire(source.id, "storage");
  const original = lease.runtime.write.bind(lease.runtime);
  let calls = 0;
  const write = spyOn(lease.runtime, "write").mockImplementation(
    async (input, ctx) => {
      if (++calls === 1) {
        entered();
        await gate;
      }
      return original(input, ctx);
    },
  );
  const uploads: Array<ReturnType<typeof f.request>> = [];
  let backup: ReturnType<typeof f.request> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const form = new FormData();
      form.set("profileId", profile);
      form.set(
        "file",
        new File(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
          ],
          "queued.svg",
          { type: "image/svg+xml" },
        ),
      );
      uploads.push(f.request("/api/files", "POST", form));
    }
    await started;
    backup = f.request("/api/system/backups", "POST");
    const deadline = Date.now() + 2000;
    while ((await f.request("/api/client-settings")).status !== 503) {
      if (Date.now() > deadline) throw new Error("Maintenance did not start");
      await Bun.sleep(1);
    }
    release();
    for (const response of await Promise.all(uploads))
      expect(response.status).toBe(201);
    write.mockRestore();
    await lease.release();
    expect((await backup).status).toBe(201);
    expect(calls).toBe(2);
  } finally {
    release();
    write.mockRestore();
    await lease.release();
    await Promise.allSettled(uploads);
    await backup;
    await f.runtime.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 15000);
