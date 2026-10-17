import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import type { Config, Definition } from "../src/plugins/api";
import type { UpgradePreview } from "../shared/config";

const context = {
  signal: new AbortController().signal,
  requestId: "upgrade",
  log() {},
};
test("storage upgrade previews credentials and required fields, preserves identity/state and drains old calls", async () => {
  const f = await fixture();
  let disposed = 0,
    initialized = 0;
  const plugin = (version: string): Definition<"storage"> => ({
    id: "example.upgrade",
    name: "Upgrade test",
    kind: "storage",
    version,
    apiVersion: 1,
    configSchemaVersion: version === "1" ? 1 : 2,
    configSchema: {
      type: "object",
      properties: {
        root: { type: "string", "x-immutable": true },
        [version === "1" ? "token" : "apiKey"]: {
          type: "string",
          "x-sensitive": true,
        },
        ...(version === "1"
          ? {}
          : {
              region: { type: "string", minLength: 1 },
              timeout: { type: "integer", default: 30 },
            }),
      },
      required:
        version === "1" ? ["root", "token"] : ["root", "apiKey", "region"],
      additionalProperties: false,
    },
    ...(version === "1"
      ? {}
      : {
          async migrateConfig(input: {
            from: { pluginVersion: string; configSchemaVersion: number };
            apiVersion: 1;
            config: Config;
          }) {
            expect(input.from).toEqual({
              pluginVersion: "1",
              configSchemaVersion: 1,
            });
            expect(input.apiVersion).toBe(1);
            expect(input.config.token).toBe("old-secret");
            return { root: input.config.root!, apiKey: input.config.token! };
          },
        }),
    async createInstance({ config }) {
      initialized++;
      if (config.region === "fail")
        throw new Error("private initialization error");
      return {
        async write() {
          return { locator: null };
        },
        async read() {
          return { type: "stream", stream: new Blob([version]).stream() };
        },
        async delete() {},
        dispose() {
          disposed++;
        },
      };
    },
  });
  try {
    f.app.plugins.register(plugin("1"), "external");
    f.app.plugins.register(plugin("2"), "external");
    const source = await f.app.plugins.save({
      pluginId: "example.upgrade",
      version: "1",
      name: "Source",
      config: { root: "/images" },
      secretEdits: { "/token": { action: "replace", value: "old-secret" } },
    });
    await f.app.db.transaction((r) =>
      r.updateState(source.id, { retained: true }, source.state_version),
    );
    const usages = await f.request(
      "/api/plugins/example.upgrade/configurations",
    );
    expect(await usages.json()).toEqual([
      {
        key: source.id,
        version: "1",
        ownerType: "source",
        ownerId: source.id,
        name: "Source",
      },
    ]);
    const res = await f.request(
      `/api/plugin-configurations/${source.id}/upgrade-preview`,
      "POST",
      { version: "2" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const preview = (await res.json()) as UpgradePreview;
    expect(preview.fields.some((x) => x.path === "/region")).toBe(true);
    expect(preview.configuration.config.timeout).toBe(30);
    expect(preview.configuration.secretEdits?.["/apiKey"]).toEqual({
      action: "replace",
      value: "old-secret",
    });
    expect(initialized).toBe(1);
    expect((await f.app.plugins.view(source.id)).version).toBe("1");
    const save = (config = preview.configuration.config) =>
      f.request(`/api/storage-sources/${source.id}`, "PUT", {
        ...preview.configuration,
        config,
        name: "Source",
        expectedVersion: source.config_version,
      });
    expect((await save()).status).toBe(400);
    expect(
      (
        await save({
          ...preview.configuration.config,
          root: "/other",
          region: "ok",
        })
      ).status,
    ).toBe(400);
    const lease = f.app.plugins.acquire(source.id, "storage");
    const stream = await lease.runtime.read(
      { storageKey: "a.png", locator: null, mode: "stream" },
      context,
    );
    const response = await save({
      ...preview.configuration.config,
      region: "ok",
    });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ id: source.id, version: "2", ready: true });
    expect(JSON.stringify(view)).not.toContain("old-secret");
    expect(
      (await f.app.db.read((r) => r.instance(source.id)))!.state_json,
    ).toEqual({ retained: true });
    expect(await f.app.plugins.revealSecret(source.id, "/apiKey")).toBe(
      "old-secret",
    );
    await expect(
      f.app.plugins.assertPackageUnused("example.upgrade", "1"),
    ).rejects.toThrow();
    expect(disposed).toBe(0);
    if (stream.type === "stream")
      expect(await new Response(stream.stream).text()).toBe("1");
    await lease.release();
    expect(disposed).toBe(1);
    await f.app.plugins.assertPackageUnused("example.upgrade", "1");
    expect(
      (await save({ ...preview.configuration.config, region: "ok" })).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test("owned stage upgrades validate parameters, keep IDs and retain saved configuration on initialization failure", async () => {
  const f = await fixture();
  const plugin = (version: string): Definition<"processor"> => ({
    id: "example.processor",
    name: "Processor",
    kind: "processor",
    version,
    apiVersion: 1,
    stages: {
      upload: {
        configSchemaVersion: version === "1" ? 1 : 2,
        configSchema: {
          type: "object",
          properties: { fail: { type: "boolean", default: false } },
          additionalProperties: false,
        },
        paramsSchema: {
          type: "object",
          properties: version === "1" ? { old: { type: "string" } } : {},
          additionalProperties: false,
        },
        async createInstance({ config }) {
          if (config.fail) throw new Error("private");
          return {
            async check() {
              return { status: "applicable" };
            },
            async process() {
              return { status: "pass" };
            },
          };
        },
      },
    },
  });
  try {
    f.app.plugins.register(plugin("1"), "external");
    f.app.plugins.register(plugin("2"), "external");
    const chain = await f.app.configuration.savePipeline({
      name: "Upload",
      kind: "upload",
      steps: [
        {
          pluginId: "example.processor",
          version: "1",
          config: {},
          enabledParams: ["old"],
          onNotApplicable: "abort",
        },
      ],
    });
    const key = chain.steps[0]!.key!;
    expect(await f.app.configuration.pluginUsages("example.processor")).toEqual(
      [
        {
          key,
          version: "1",
          ownerType: "pipeline",
          ownerId: chain.id,
          name: "Upload",
          stage: "upload",
          stepIndex: 0,
        },
      ],
    );
    f.app.plugins.register(
      {
        ...plugin("3"),
        stages: {
          post_save: {
            configSchemaVersion: 1,
            configSchema: { type: "object", properties: {} },
            async createInstance() {
              return {
                async execute() {
                  return { status: "pass" };
                },
              };
            },
          },
        },
      },
      "external",
    );
    await expect(f.app.plugins.previewUpgrade(key, "3")).rejects.toThrow();

    const preview = await f.app.plugins.previewUpgrade(key, "2");
    const steps = [{ ...chain.steps[0]!, ...preview.configuration }];
    await expect(
      f.app.configuration.savePipeline(
        { ...chain, expectedVersion: chain.configVersion, steps },
        chain.id,
      ),
    ).rejects.toThrow();
    expect((await f.app.plugins.view(key)).version).toBe("1");
    steps[0]!.enabledParams = [];
    steps[0]!.config.fail = true;
    const saved = await f.app.configuration.savePipeline(
      { ...chain, expectedVersion: chain.configVersion, steps },
      chain.id,
    );
    expect(saved.steps[0]).toMatchObject({ key, version: "2", ready: false });
    saved.steps[0]!.config.fail = false;
    const fixed = await f.app.configuration.savePipeline(
      { ...saved, expectedVersion: saved.configVersion },
      saved.id,
    );
    expect(fixed.steps[0]).toMatchObject({ key, version: "2", ready: true });
  } finally {
    await f.close();
  }
});

test("upgrade refuses stale credentials and failed migrations without changing the instance", async () => {
  const f = await fixture();
  const definition = (version: string): Definition<"path"> => ({
    id: "example.path-upgrade",
    name: "Path",
    version,
    kind: "path",
    apiVersion: 1,
    configSchemaVersion: 1,
    configSchema: { type: "object", properties: {} },
    ...(version === "3"
      ? {
          async migrateConfig() {
            throw new Error("secret must not leak");
          },
        }
      : {}),
    async createInstance() {
      return {
        async generate() {
          return { logicalKey: "a.png" };
        },
      };
    },
  });
  try {
    for (const version of ["1", "2", "3"])
      f.app.plugins.register(definition(version), "external");
    const profile = await f.app.configuration.profileEditor(f.profileId);
    const saved = await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        path: { pluginId: "example.path-upgrade", version: "1", config: {} },
      },
      profile.id,
    );
    const key = saved.path.key!;
    expect(
      await f.app.configuration.pluginUsages("example.path-upgrade"),
    ).toEqual([
      {
        key,
        version: "1",
        ownerType: "profile",
        ownerId: saved.id,
        name: saved.name,
      },
    ]);
    const preview = await f.app.plugins.previewUpgrade(key, "2");
    const old = (await f.app.db.read((r) => r.instance(key)))!;
    await f.app.db.transaction((r) =>
      r.updateSecrets(key, old.secrets_encrypted!, old.secrets_version),
    );
    await expect(
      f.app.configuration.saveProfileEditor(
        {
          ...saved,
          expectedVersion: saved.configVersion,
          path: preview.configuration,
        },
        saved.id,
      ),
    ).rejects.toThrow();
    const failed = await f.request(
      `/api/plugin-configurations/${key}/upgrade-preview`,
      "POST",
      { version: "3" },
    );
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain("secret must not leak");
    const fresh = await f.app.plugins.previewUpgrade(key, "2");
    const upgraded = await f.app.configuration.saveProfileEditor(
      {
        ...saved,
        expectedVersion: saved.configVersion,
        path: fresh.configuration,
      },
      saved.id,
    );
    expect(upgraded.path).toMatchObject({ key, version: "2" });
  } finally {
    await f.close();
  }
});
