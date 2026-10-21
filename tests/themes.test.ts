import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { themePackage } from "./theme-fixtures";
import { zip } from "./package-fixtures";
import { handler } from "../src/http/app";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("theme drafts, activation snapshots, concurrency, versions and recovery", async () => {
  const f = await fixture();
  try {
    const manager = f.app.themes;
    const stage = await manager.inspect(themePackage());
    await expect(manager.install(stage.ticket, false)).rejects.toThrow();
    await manager.install(stage.ticket, true);
    expect(manager.active()).toBeNull();
    await manager.configure("example.theme", "1.0.0", {
      heading: "Published",
      count: 2,
    });
    await manager.activate({ id: "example.theme", version: "1.0.0" });
    await manager.configure("example.theme", "1.0.0", {
      heading: "Draft",
      count: 3,
    });
    expect(manager.active()!.config.heading).toBe("Published");
    expect(manager.preview("example.theme", "1.0.0").config.heading).toBe(
      "Draft",
    );
    await expect(manager.uninstall("example.theme", "1.0.0")).rejects.toThrow();
    await expect(manager.inspect(themePackage())).rejects.toThrow();
    await expect(
      manager.configure("example.theme", "1.0.0", { count: 0 }),
    ).rejects.toThrow();
    await expect(
      manager.configure("example.theme", "1.0.0", { unexpected: true }),
    ).rejects.toThrow();
    const second = await manager.inspect(themePackage("2.0.0"));
    await manager.install(second.ticket, true);
    const operations = await Promise.allSettled([
      manager.activate({ id: "example.theme", version: "2.0.0" }),
      manager.uninstall("example.theme", "2.0.0"),
    ]);
    expect(operations.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
    await f.restart();
    expect(f.app.themes.active()!.manifest.version).toBe("2.0.0");
    await f.app.themes.activate(null);
    await f.app.themes.uninstall("example.theme", "1.0.0");
    expect(f.app.themes.list()).toHaveLength(1);
    await f.restart();
    expect(f.app.themes.active()).toBeNull();
  } finally {
    await f.close();
  }
});

test("theme packages reject traversal, missing entry, symlinks and unknown API", async () => {
  const f = await fixture();
  try {
    for (const bytes of [
      zip({ "../escape": "x" }),
      zip({ "entry.js": "x" }),
      zip({ "entry.js": "x" }, { mode: 0xa1ff }),
      zip({
        "theme.json": JSON.stringify({
          id: "theme",
          version: "1",
          name: "x",
          apiVersion: 2,
          defaultLocale: "en-US",
          pages: { home: { entry: "missing.js" } },
        }),
      }),
    ])
      await expect(f.app.themes.inspect(bytes)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("theme HTTP enforces owner, CSRF and preview permissions; resources never serve HTML fallbacks", async () => {
  const f = await fixture();
  try {
    const handle = handler(f.app);
    const request = (
      path: string,
      method = "GET",
      body?: BodyInit,
      auth = true,
      csrf = true,
    ) =>
      handle(
        new Request("http://localhost" + path, {
          method,
          headers: {
            ...(auth ? { cookie: f.cookie } : {}),
            ...(csrf ? { "x-csrf-token": f.csrf } : {}),
          },
          body,
        }),
      );
    expect((await request("/api/theme", "GET", undefined, false)).status).toBe(
      200,
    );
    expect((await request("/api/themes", "GET", undefined, false)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          "/api/themes/inspect",
          "POST",
          themePackage(),
          true,
          false,
        )
      ).status,
    ).toBe(403);
    const stage = await (
      await request("/api/themes/inspect", "POST", themePackage())
    ).json();
    expect(
      (
        await f.request("/api/themes/install", "POST", {
          ticket: stage.ticket,
          confirmed: true,
        })
      ).status,
    ).toBe(200);
    const path = "/api/themes/example.theme/1.0.0/preview";
    expect((await request(path, "GET", undefined, false)).status).toBe(401);
    expect((await request(path)).status).toBe(200);
    const resource = await request(
      "/assets/themes/example.theme/1.0.0/entry.js",
      "GET",
      undefined,
      false,
    );
    expect(resource.headers.get("content-type")).toContain("javascript");
    expect(resource.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (await request("/assets/themes/example.theme/1.0.0/missing.js")).status,
    ).toBe(404);
    const user = await (
      await f.request("/api/users", "POST", {
        username: "theme-admin",
        password: "test-password-123",
        role: "admin",
        profileIds: [],
      })
    ).json();
    expect(user.id).toBeDefined();
    const logged = await request(
      "/api/auth/login",
      "POST",
      JSON.stringify({
        username: "theme-admin",
        password: "test-password-123",
      }),
      false,
    );
    const cookie = logged.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await handle(
          new Request("http://localhost/api/themes", { headers: { cookie } }),
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});

test("theme languages, empty content, atomic publication and stale drafts", async () => {
  const f = await fixture();
  try {
    const { manifest, configuration } = await import("../src/themes/schema");
    const base = {
      id: "language.theme",
      defaultLocale: "en-US",
      content: { "en-US": { name: "Languages" } },
      version: "1",
      apiVersion: 1,
      supportedLocales: ["en-US"],
      messages: { "en-US": { hello: "Hello" } },
      pages: { home: { entry: "entry.js" } },
      configSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            "x-localized": true,
            default: { "en-US": "Default" },
          },
        },
      },
    };
    for (const extra of [
      { name: "Old top-level name" },
      { defaultLocale: undefined },
      { content: undefined },
      { messages: { "zh-CN": { hello: "你好" } } },
      { messages: { "en-US": { hello: " " } } },
      {
        messages: { "en-US": {}, "zh-CN": { toString: "Text" } },
        supportedLocales: ["en-US", "zh-CN"],
      },
      { supportedLocales: [] },
      { supportedLocales: ["ja-JP"] },
      { defaultLocale: "zh-CN" },
      { content: { "en-US": { name: " " } } },
      { content: { "en-US": { name: 42 } } },
      { content: { "ja-JP": { name: "Name" } } },
      { content: { "en-US": { name: "Name", unexpected: true } } },
      {
        supportedLocales: ["en-US", "zh-CN"],
        messages: { "en-US": {}, "zh-CN": { hello: "你好" } },
      },
    ])
      expect(() => manifest({ ...base, ...extra })).toThrow();
    expect(
      manifest({
        ...base,
        content: {
          "en-US": { name: "Languages" },
          "zh-CN": { name: "语言主题" },
        },
      }).content?.["zh-CN"]?.name,
    ).toBe("语言主题");
    expect(
      manifest({ ...base, supportedLocales: ["en-US", "zh-CN"] }).messages,
    ).toEqual(base.messages);
    const m = manifest(base);
    expect(
      configuration(m.configSchema, { title: { "en-US": "" } }, false),
    ).toEqual({ title: { "en-US": "" } });
    const stage = await f.app.themes.inspect(
      zip({
        "theme.json": JSON.stringify(base),
        "entry.js": "export function mount(){return {dispose(){}}}",
      }),
    );
    await f.app.themes.install(stage.ticket, true);
    const revision = f.app.delivery.store.get().languageRevision;
    await f.app.themes.configure(
      base.id,
      base.version,
      { title: { "en-US": "" } },
      { defaultLocale: "en-US", languageRevision: revision },
    );
    await f.app.delivery.save({
      ...f.app.delivery.get(),
      defaultLocale: "zh-CN",
    });
    await expect(
      f.app.themes.activate({
        id: base.id,
        version: base.version,
        defaultLocale: "en-US",
        languageRevision: revision,
      }),
    ).rejects.toThrow("changed");
    expect(f.app.themes.active()).toBeNull();
    const nextRevision = f.app.delivery.store.get().languageRevision;
    const path = join(f.root, "site-settings.json");
    const { rename, mkdir, rm } = await import("node:fs/promises");
    await rename(path, path + ".saved");
    await mkdir(path);
    await expect(
      f.app.themes.activate({
        id: base.id,
        version: base.version,
        defaultLocale: "en-US",
        languageRevision: nextRevision,
      }),
    ).rejects.toThrow();
    expect(f.app.delivery.get().defaultLocale).toBe("zh-CN");
    expect(f.app.themes.active()).toBeNull();
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.app.themes.activate({
      id: base.id,
      version: base.version,
      defaultLocale: "en-US",
      languageRevision: nextRevision,
    });
    expect(f.app.delivery.get().defaultLocale).toBe("en-US");
    expect(f.app.themes.active()!.config.title).toEqual({ "en-US": "" });
    await expect(
      f.app.delivery.save({ ...f.app.delivery.get(), defaultLocale: "zh-CN" }),
    ).rejects.toThrow("supported");
    await f.restart();
    expect(f.app.themes.active()!.manifest.id).toBe(base.id);
    expect(f.app.delivery.get().defaultLocale).toBe("en-US");
    const { siteText } = await import("../shared/locales");
    expect(
      siteText(
        {
          defaultLocale: "en-US",
          enabledLocales: ["en-US", "zh-CN"],
          content: { "en-US": { name: "Name" }, "zh-CN": { name: "" } },
        },
        "zh-CN",
        "name",
      ),
    ).toBe("");
  } finally {
    await f.close();
  }
});

test("theme installation persists defaults once; reads and activation never refill cleared drafts", async () => {
  const f = await fixture();
  try {
    const manager = f.app.themes;
    const stage = await manager.inspect(themePackage());
    await manager.install(stage.ticket, true);
    const saved = await Bun.file(join(f.root, "site-settings.json")).json();
    expect(saved.themes.drafts["example.theme@1.0.0"]).toEqual({
      heading: "Original",
      count: 1,
      welcome: { "en-US": "Welcome", "zh-CN": "欢迎" },
    });
    await manager.configure("example.theme", "1.0.0", {
      heading: "",
      welcome: {},
    });
    await f.restart();
    expect(f.app.themes.preview("example.theme", "1.0.0").config).toEqual({
      heading: "",
      welcome: {},
    });
    await f.app.themes.activate({ id: "example.theme", version: "1.0.0" });
    expect(f.app.themes.active()!.config).toEqual({ heading: "", welcome: {} });
  } finally {
    await f.close();
  }
});

test("configuration validation does not initialize defaults implicitly or accept missing required groups", async () => {
  const { configuration } = await import("../src/themes/schema");
  const schema = {
    type: "object" as const,
    properties: {
      text: { type: "string" as const, default: "Initial" },
      group: {
        type: "object" as const,
        properties: { label: { type: "string" as const, default: "Nested" } },
      },
    },
  };
  expect(configuration(schema, {})).toEqual({});
  expect(configuration(schema, {}, true)).toEqual({
    text: "Initial",
    group: { label: "Nested" },
  });
  expect(() => configuration({ ...schema, required: ["group"] }, {})).toThrow();
  expect(configuration(schema, { text: "", group: { label: "" } })).toEqual({
    text: "",
    group: { label: "" },
  });
});

test("failed theme default persistence rolls back installation and permits retry", async () => {
  const f = await fixture();
  const { rename, mkdir, rm } = await import("node:fs/promises");
  const path = join(f.root, "site-settings.json");
  try {
    const staged = await f.app.themes.inspect(themePackage());
    await rename(path, path + ".saved");
    await mkdir(path);
    await expect(f.app.themes.install(staged.ticket, true)).rejects.toThrow();
    expect(f.app.themes.list()).toHaveLength(0);
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
    await f.app.themes.install(staged.ticket, true);
    expect(f.app.themes.preview("example.theme", "1.0.0").config.heading).toBe(
      "Original",
    );
  } finally {
    await f.close();
  }
});

test("invalid existing settings are rejected rather than treated as a fresh installation", async () => {
  const { SiteSettings } = await import("../src/infra/site-settings");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "theme-settings-validation-"));
  try {
    for (const contents of [
      "null",
      "false",
      JSON.stringify({
        format: 1,
        languageRevision: 0,
        themes: { drafts: {}, active: null },
      }),
    ]) {
      await writeFile(join(root, "site-settings.json"), contents);
      await expect(new SiteSettings(root).load()).rejects.toThrow(
        "Invalid site settings",
      );
      expect(await readFile(join(root, "site-settings.json"), "utf8")).toBe(
        contents,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete required configuration can be installed and drafted but not previewed or applied", async () => {
  const f = await fixture();
  try {
    const manifest = {
      id: "required.theme",
      defaultLocale: "en-US",
      content: { "en-US": { name: "Required" } },
      version: "1",
      apiVersion: 1,
      supportedLocales: ["en-US", "zh-CN"],
      messages: { "en-US": {}, "zh-CN": {} },
      pages: { home: { entry: "entry.js" } },
      configSchema: {
        type: "object",
        required: ["title", "group", "localized"],
        properties: {
          title: { type: "string", minLength: 2, maxLength: 10 },
          optional: { type: "string", default: "Initial" },
          localized: { type: "string", "x-localized": true, minLength: 1 },
          group: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer", minimum: 1 } },
          },
        },
      },
    };
    const staged = await f.app.themes.inspect(
      zip({
        "theme.json": JSON.stringify(manifest),
        "entry.js": "export function mount(){return {dispose(){}}}",
      }),
    );
    await f.app.themes.install(staged.ticket, true);
    expect(f.app.themes.list()[0]!.config.optional).toBe("Initial");
    expect(() => f.app.themes.preview(manifest.id, "1")).toThrow();
    const revision = f.app.delivery.store.get().languageRevision;
    const url = "/api/themes/required.theme/1";
    const draft = {
      config: {},
      language: { defaultLocale: "en-US", languageRevision: revision },
    };
    expect((await f.request(url + "/config", "PUT", draft)).status).toBe(200);
    expect((await f.request(url + "/preview")).status).toBe(400);
    expect(
      (
        await f.request("/api/theme", "PUT", {
          id: manifest.id,
          version: "1",
          ...draft.language,
        })
      ).status,
    ).toBe(400);
    expect(f.app.themes.active()).toBeNull();
    for (const title of ["", "x", "too long a title", 7])
      await expect(
        f.app.themes.configure(manifest.id, "1", { title }),
      ).rejects.toThrow();
    await f.app.themes.configure(manifest.id, "1", {
      title: "OK",
      group: { count: 1 },
      localized: { "en-US": "Hello" },
    });
    expect(() => f.app.themes.preview(manifest.id, "1")).toThrow();
    await f.app.themes.configure(manifest.id, "1", {
      title: "OK",
      group: { count: 1 },
      localized: { "en-US": "Hello", "zh-CN": "你好" },
      optional: "",
    });
    expect(f.app.themes.preview(manifest.id, "1").config.optional).toBe("");
    await f.app.themes.activate({
      id: manifest.id,
      version: "1",
      ...draft.language,
    });
    expect(f.app.themes.active()!.config.optional).toBe("");
    await f.app.themes.configure(manifest.id, "1", {});
    expect(f.app.themes.active()!.config.title).toBe("OK");
    await f.restart();
    expect(f.app.themes.list()[0]!.config).toEqual({});
    expect(f.app.themes.active()!.config.title).toBe("OK");
  } finally {
    await f.close();
  }
});

test("theme minLength schema and provided defaults are validated", async () => {
  const { validateField, configuration } = await import("../src/themes/schema");
  for (const field of [
    { type: "string", minLength: -1 },
    { type: "string", minLength: 1.5 },
    { type: "string", minLength: 5, maxLength: 2 },
    { type: "number", minLength: 1 },
  ])
    expect(() => validateField(field)).toThrow();
  const schema = {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, minLength: 2, default: "x" },
    },
  };
  expect(() => configuration(schema, {}, true, false)).toThrow();
});
