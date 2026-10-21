import { expect, test } from "bun:test";
import { PluginManager } from "../src/plugins/manager";
import { Secrets } from "../src/infra/secrets";
import type { ConfigSchema, FieldSchema } from "../plugin-sdk/schema";
import type { Definition } from "../plugin-sdk/api";
import type { Instance, Persistence } from "../src/persistence/port";

function fixture(schema: ConfigSchema) {
  const records = new Map<string, Instance>();
  const secrets = new Secrets("00".repeat(32));
  const db = {
    read: async (fn: any) => fn({ instance: (id: string) => records.get(id) }),
  } as Persistence;
  const manager = new PluginManager(db, secrets, "/unused");
  for (const version of ["1", "2"])
    manager.register(
      {
        id: "test.immutable-secret",
        version,
        kind: "path",
        apiVersion: 1,
        defaultLocale: "en-US",
        nameKey: "name",
        messages: { "en-US": { name: "Immutable secret" } },
        configSchemaVersion: 1,
        configSchema: schema,
        async createInstance() {
          throw new Error("Not used");
        },
      } as Definition<"path">,
      "external",
    );
  return { records, secrets, manager };
}

for (const field of [
  { type: "string", "x-sensitive": true, "x-immutable": true },
  {
    type: "array",
    "x-immutable": true,
    items: { type: "string", "x-sensitive": true },
  },
] as FieldSchema[])
  test(`immutable sensitive ${field.type} rejects replacement and clearing, including upgrades`, async () => {
    const { manager, records, secrets } = fixture({
      type: "object",
      properties: { token: field },
    });
    const value = field.type === "array" ? ["original"] : "original";
    const changed = field.type === "array" ? ["changed"] : "changed";
    const input = {
      pluginId: "test.immutable-secret",
      version: "1",
      name: "Secret",
      config: {},
    };
    const first = await manager.prepare({
      ...input,
      secretEdits: { "/token": { action: "replace", value } },
    });
    records.set(first.record.id, first.record);
    const update = {
      ...input,
      id: first.record.id,
      expectedVersion: first.record.config_version,
    };
    for (const upgrading of [false, true]) {
      const operation = upgrading
        ? {
            version: "2",
            upgrade: {
              fromVersion: "1",
              configVersion: first.record.config_version,
              secretsVersion: first.record.secrets_version,
            },
          }
        : {};
      for (const action of ["replace", "clear"] as const)
        await expect(
          manager.prepare({
            ...update,
            ...operation,
            secretEdits: { "/token": { action, value: changed } },
          }),
        ).rejects.toMatchObject({ code: "NEW_INSTANCE_REQUIRED" });
      const unchanged = await manager.prepare({ ...update, ...operation });
      expect(
        secrets.decrypt(
          unchanged.record.secrets_encrypted,
          unchanged.record.id,
        ),
      ).toEqual({ token: value });
    }
    const copy = await manager.prepareCopy(first.record.id);
    expect(copy.record.id).not.toBe(first.record.id);
    expect(
      secrets.decrypt(copy.record.secrets_encrypted, copy.record.id),
    ).toEqual({ token: value });
  });

test("immutable parent protects its secret children while allowing identical replacements", async () => {
  const { manager, records } = fixture({
    type: "object",
    properties: {
      target: {
        type: "object",
        "x-immutable": true,
        properties: {
          label: { type: "string" },
          token: { type: "string", "x-sensitive": true },
        },
      },
    },
  });
  const input = {
    pluginId: "test.immutable-secret",
    version: "1",
    name: "Parent",
    config: { target: { label: "same" } },
  };
  const first = await manager.prepare({
    ...input,
    secretEdits: { "/target/token": { action: "replace", value: "original" } },
  });
  records.set(first.record.id, first.record);
  const update = {
    ...input,
    id: first.record.id,
    expectedVersion: first.record.config_version,
  };
  await manager.prepare({
    ...update,
    secretEdits: { "/target/token": { action: "replace", value: "original" } },
  });
  for (const action of ["replace", "clear"] as const)
    await expect(
      manager.prepare({
        ...update,
        secretEdits: { "/target/token": { action, value: "changed" } },
      }),
    ).rejects.toMatchObject({ code: "NEW_INSTANCE_REQUIRED" });
});

test("upgrade may initialize a previously missing immutable secret", async () => {
  const { manager, records, secrets } = fixture({
    type: "object",
    properties: {
      token: { type: "string", "x-sensitive": true, "x-immutable": true },
    },
  });
  const input = {
    pluginId: "test.immutable-secret",
    version: "1",
    name: "Upgrade",
    config: {},
  };
  const first = await manager.prepare(input);
  records.set(first.record.id, first.record);
  const upgraded = await manager.prepare({
    ...input,
    version: "2",
    id: first.record.id,
    expectedVersion: first.record.config_version,
    upgrade: {
      fromVersion: "1",
      configVersion: first.record.config_version,
      secretsVersion: first.record.secrets_version,
    },
    secretEdits: { "/token": { action: "replace", value: "new" } },
  });
  expect(
    secrets.decrypt(upgraded.record.secrets_encrypted, upgraded.record.id),
  ).toEqual({ token: "new" });
});
