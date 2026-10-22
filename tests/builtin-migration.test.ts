import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../src/plugins/manager";
import { Secrets } from "../src/infra/secrets";
import { entity, type Instance } from "../src/persistence/port";
import { openSQLite } from "../src/persistence/sqlite/store";
import type { Config, Definition } from "../src/plugins/api";
import { fixture } from "./helpers";

const identity = {
  id: "builtin.migration-test",
  version: "3.0.0",
  apiVersion: 1 as const,
  defaultLocale: "en-US",
  nameKey: "name",
  messages: { "en-US": { name: "Migration test" } },
};

async function migrationFixture() {
  const root = await mkdtemp(join(tmpdir(), "picloom-builtin-migration-"));
  const db = await openSQLite(join(root, "db.sqlite"));
  const secrets = new Secrets("00".repeat(32));
  const managers: PluginManager[] = [];
  const manager = () => {
    const value = new PluginManager(db, secrets, root);
    managers.push(value);
    return value;
  };
  const seed = async (
    changes: Partial<Instance> = {},
    credentials: Config = {},
  ) => {
    const record: Instance = {
      ...entity(),
      plugin_id: identity.id,
      plugin_version: "1.0.0",
      kind: "path",
      stage: null,
      name: "Existing instance",
      max_storage_bytes: null,
      config_json: {},
      config_version: 4,
      config_schema_version: 1,
      secrets_encrypted: null,
      secrets_version: 2,
      state_json: { retained: true },
      state_version: 5,
      last_init_error: null,
      ...changes,
    };
    record.secrets_encrypted = secrets.encrypt(credentials, record.id);
    await db.transaction((r) => r.saveInstance(record));
    return record;
  };
  return {
    db,
    secrets,
    manager,
    seed,
    async close() {
      for (const value of managers) await value.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("startup updates built-in code versions, preserves file references and remains idempotent", async () => {
  const f = await fixture();
  try {
    const response = await f.upload();
    expect(response.status).toBe(201);
    const file = await response.json();
    const instances = await f.app.db.read((r) => r.instances());
    const source = instances.find((i) => i.plugin_id === "builtin.local")!;
    const profile = await f.app.db.read((r) => r.profile(f.profileId));
    const old = { ...source, plugin_version: "0.9.0" };
    await f.app.db.transaction((r) =>
      r.saveInstance(old, source.config_version),
    );
    await f.restart();
    const migrated = (await f.app.db.read((r) => r.instance(old.id)))!;
    expect(migrated).toMatchObject({
      ...old,
      plugin_version: "1.0.0",
      config_version: old.config_version + 1,
      secrets_version: old.secrets_version + 1,
      secrets_encrypted: expect.any(String),
      updated_at: expect.any(Number),
    });
    expect(f.app.plugins.isReady(old.id)).toBe(true);
    expect(await f.app.db.read((r) => r.profile(f.profileId))).toEqual(profile);
    const image = await f.request(new URL(file.url).pathname);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer()).equals(f.png)).toBe(true);
    await f.restart();
    const restarted = (await f.app.db.read((r) => r.instance(old.id)))!;
    expect(restarted).toEqual({ ...migrated, updated_at: expect.any(Number) });
  } finally {
    await f.close();
  }
});

test("built-in configuration migration crosses versions, converts secrets and precedes initialization", async () => {
  const f = await migrationFixture();
  try {
    const old = await f.seed(
      {
        kind: "storage",
        config_json: { root: "/existing", width: 40 },
        max_storage_bytes: 1024,
      },
      { token: "old-secret" },
    );
    let migrations = 0;
    let initialized = 0;
    const definition: Definition<"storage"> = {
      ...identity,
      kind: "storage",
      configSchemaVersion: 3,
      configSchema: {
        type: "object",
        properties: {
          root: { type: "string", "x-immutable": true },
          maxWidth: { type: "integer" },
          timeout: { type: "integer", default: 30 },
          credentials: {
            type: "object",
            properties: { apiKey: { type: "string", "x-sensitive": true } },
            required: ["apiKey"],
            additionalProperties: false,
          },
        },
        required: ["root", "maxWidth", "timeout", "credentials"],
        additionalProperties: false,
      },
      async migrateConfig({ from, config }) {
        migrations++;
        expect(from).toEqual({
          pluginVersion: "1.0.0",
          configSchemaVersion: 1,
        });
        expect(config.token).toBe("old-secret");
        return {
          root: config.root!,
          maxWidth: config.width!,
          timeout: 30,
          credentials: { apiKey: config.token! },
        };
      },
      async validateConfig(config) {
        expect(config.credentials).toEqual({ apiKey: "old-secret" });
        return [];
      },
      async createInstance({ id, config, services }) {
        initialized++;
        expect(config).toEqual({
          root: "/existing",
          maxWidth: 40,
          timeout: 30,
          credentials: {},
        });
        expect((await services.readSecrets()).value).toEqual({
          credentials: { apiKey: "old-secret" },
        });
        expect(
          (await f.db.read((r) => r.instance(id)))?.config_schema_version,
        ).toBe(3);
        return {
          async write() {
            return { locator: null };
          },
          async read() {
            return { type: "stream", stream: new Blob().stream() };
          },
          async delete() {},
        };
      },
    };
    const manager = f.manager();
    manager.register(definition);
    await manager.start();
    const migrated = (await f.db.read((r) => r.instance(old.id)))!;
    expect(manager.isReady(old.id)).toBe(true);
    expect(migrated).toMatchObject({
      id: old.id,
      name: old.name,
      max_storage_bytes: 1024,
      state_json: old.state_json,
      state_version: old.state_version,
      plugin_version: identity.version,
      config_schema_version: 3,
      config_version: 5,
      secrets_version: 3,
    });
    expect(migrated.config_json).not.toHaveProperty("token");
    await manager.close();
    const restarted = f.manager();
    restarted.register(definition);
    await restarted.start();
    expect(migrations).toBe(1);
    expect(initialized).toBe(2);
    expect(await f.db.read((r) => r.instance(old.id))).toEqual({
      ...migrated,
      updated_at: expect.any(Number),
    });
  } finally {
    await f.close();
  }
});

test("processor migration selects each original stage and leaves external configurations unchanged", async () => {
  const f = await migrationFixture();
  try {
    const upload = await f.seed({ kind: "processor", stage: "upload" });
    const access = await f.seed({ kind: "processor", stage: "access" });
    const external = await f.seed({ plugin_id: "example.external" });
    const migratedStages: string[] = [];
    const stage = (name: string, configSchemaVersion: number) => ({
      configSchemaVersion,
      configSchema: {
        type: "object" as const,
        properties: { value: { type: "string" as const } },
        required: ["value"],
        additionalProperties: false as const,
      },
      async migrateConfig() {
        migratedStages.push(name);
        return { value: name };
      },
      async createInstance({ config }: { config: Readonly<Config> }) {
        expect(config).toEqual({ value: name });
        return {
          async check() {
            return { status: "applicable" as const };
          },
          async process() {
            return { status: "pass" as const };
          },
        };
      },
    });
    const manager = f.manager();
    manager.register({
      ...identity,
      kind: "processor",
      stages: { upload: stage("upload", 2), access: stage("access", 3) },
    });
    manager.register(
      {
        ...identity,
        id: external.plugin_id,
        version: external.plugin_version,
        kind: "path",
        configSchemaVersion: 1,
        async createInstance() {
          return {
            async generate() {
              return { logicalKey: "external" };
            },
          };
        },
      },
      "external",
    );
    await manager.start();
    expect(migratedStages.sort()).toEqual(["access", "upload"]);
    expect(manager.isReady(upload.id)).toBe(true);
    expect(manager.isReady(access.id)).toBe(true);
    expect(await f.db.read((r) => r.instance(external.id))).toEqual({
      ...external,
      updated_at: expect.any(Number),
    });
  } finally {
    await f.close();
  }
});

for (const scenario of [
  "conversion",
  "schema",
  "semantic",
  "semantic-exception",
  "downgrade",
  "target",
] as const)
  test(`built-in ${scenario} failure aborts startup without saving configuration`, async () => {
    const f = await migrationFixture();
    try {
      const old = await f.seed({ config_json: { root: "/existing" } });
      let initialized = false;
      const manager = f.manager();
      manager.register({
        ...identity,
        kind: "path",
        configSchemaVersion: scenario === "downgrade" ? 1 : 2,
        configSchema: {
          type: "object",
          properties: {
            root: { type: "string", "x-immutable": true },
            timeout: { type: "integer", default: 30 },
          },
          required: ["root", "timeout"],
          additionalProperties: false,
        },
        async migrateConfig(): Promise<Config> {
          if (scenario === "conversion") throw new Error("private secret");
          return scenario === "schema"
            ? { root: "/existing" }
            : {
                root: scenario === "target" ? "/changed" : "/existing",
                timeout: 30,
              };
        },
        async validateConfig() {
          if (scenario === "semantic-exception")
            throw new Error("private secret");
          return scenario === "semantic" ? [{ message: "private secret" }] : [];
        },
        async createInstance() {
          initialized = true;
          return {
            async generate() {
              return { logicalKey: "test" };
            },
          };
        },
      });
      if (scenario === "downgrade") {
        old.config_schema_version = 3;
        await f.db.transaction((r) => r.saveInstance(old, old.config_version));
      }
      const failure = await manager.start().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("private secret");
      expect(await f.db.read((r) => r.instance(old.id))).toEqual(old);
      expect(initialized).toBe(false);
    } finally {
      await f.close();
    }
  });

test("built-in schema bumps can retain compatible configurations without a migration function", async () => {
  const f = await migrationFixture();
  try {
    const old = await f.seed({ plugin_version: identity.version });
    const manager = f.manager();
    const definition: Definition<"path"> = {
      ...identity,
      kind: "path",
      configSchemaVersion: 2,
      async createInstance() {
        return {
          async generate() {
            return { logicalKey: "test" };
          },
        };
      },
    };
    manager.register(definition);
    expect(() => manager.register({ ...definition, version: "4.0.0" })).toThrow(
      "Built-in plugin already loaded",
    );
    await manager.start();
    expect(manager.isReady(old.id)).toBe(true);
    expect(
      (await f.db.read((r) => r.instance(old.id)))?.config_schema_version,
    ).toBe(2);
  } finally {
    await f.close();
  }
});
