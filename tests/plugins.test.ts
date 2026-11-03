import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { retainStream } from "../src/infra/files";
import { Secrets } from "../src/infra/secrets";
import { entity } from "../src/persistence/port";
import type { Definition } from "../src/plugins/api";
const context = () => ({
  signal: new AbortController().signal,
  requestId: "test",
  log() {},
});
test("stream cancellation keeps retired instance alive until resource release", async () => {
  const f = await fixture();
  let disposed = 0,
    cancelled = 0;
  try {
    const def: Definition<"storage"> = {
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: {
        "en-US": {
          "package.name": "stream",
        },
      },

      id: "test.stream",

      kind: "storage",
      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async createInstance() {
        return {
          async write() {
            return {};
          },
          async delete() {},
          async read() {
            return {
              type: "stream",
              stream: new ReadableStream({
                cancel() {
                  cancelled++;
                },
              }),
            };
          },
          dispose() {
            disposed++;
          },
        };
      },
    };
    f.app.plugins.register(def);
    const record = await f.app.plugins.save({
      pluginId: def.id,
      version: "1",
      name: "test",
      config: {},
    });
    const lease = f.app.plugins.acquire(record.id, "storage");
    const result = await lease.runtime.read(
      { storageKey: "x", locator: null, mode: "stream" },
      context(),
    );
    if (result.type !== "stream") throw new Error();
    const stream = retainStream(result.stream, lease.release);
    await f.app.plugins.save({
      id: record.id,
      pluginId: def.id,
      version: "1",
      name: "new",
      config: {},
      expectedVersion: 1,
    });
    expect(disposed).toBe(0);
    await stream.cancel();
    expect(cancelled).toBe(1);
    expect(disposed).toBe(1);
  } finally {
    await f.close();
  }
});
test("initialization failure preserves new settings and retires old instance", async () => {
  const f = await fixture();
  try {
    const def: Definition<"processor"> = {
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "failure" } },

      id: "test.failure",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        access: {
          configSchemaVersion: 1,
          configSchema: {
            type: "object",
            properties: { fail: { type: "boolean", default: false } },
            additionalProperties: false,
          },
          async createInstance({ config }) {
            if (config.fail) throw new Error("sensitive diagnostics");
            return {
              async process() {
                return { status: "pass" };
              },
            };
          },
        },
      },
    };
    f.app.plugins.register(def);
    const record = await f.app.plugins.save({
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "test",
      config: {},
    });
    const next = await f.app.plugins.save({
      id: record.id,
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "test",
      config: { fail: true },
      expectedVersion: 1,
    });
    expect(next.config_json.fail).toBe(true);
    expect(next.last_init_error).not.toContain("sensitive");
    expect(() => f.app.plugins.acquire(record.id, "access")).toThrow(
      "unavailable",
    );
  } finally {
    await f.close();
  }
});
test("credentials are encrypted, kept on edits and protected by versions", async () => {
  const f = await fixture();
  try {
    let observed = "";
    const def: Definition<"processor"> = {
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "secret" } },

      id: "test.secret",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        access: {
          configSchemaVersion: 1,
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string", "x-sensitive": true },
              label: { type: "string", default: "x" },
              note: { type: "string" },
            },
            required: ["token"],
            additionalProperties: false,
          },
          async createInstance({ config, services }) {
            expect(config.token).toBeUndefined();
            observed = String((await services.readSecrets()).value.token);
            return {
              async process() {
                return { status: "pass" };
              },
            };
          },
        },
      },
    };
    f.app.plugins.register(def);
    const record = await f.app.plugins.save({
      secretEdits: { "/token": { action: "replace", value: "do-not-leak" } },
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "test",
      config: { note: "remove-on-save" },
    });
    expect(observed).toBe("do-not-leak");
    expect(record.secrets_encrypted).not.toContain("do-not-leak");
    expect(record.config_json.token).toBeUndefined();
    await f.app.plugins.save({
      id: record.id,
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "test",
      config: { label: "y" },
      expectedVersion: 1,
    });
    expect(observed).toBe("do-not-leak");
    expect(
      (await f.app.db.read((r) => r.instance(record.id)))!.config_json,
    ).toEqual({ label: "y" });
    const duplicate = await f.app.plugins.prepareCopy(record.id);
    await f.app.db.transaction((r) =>
      f.app.plugins.persistPrepared(r, duplicate),
    );
    await f.app.plugins.activate(duplicate.record.id);
    expect(observed).toBe("do-not-leak");
    expect(duplicate.record.config_json).toEqual({ label: "y" });
    const secrets = new Secrets(f.overrides.encryptionKey);
    expect(() =>
      secrets.decrypt(record.secrets_encrypted, "another-id"),
    ).toThrow();
  } finally {
    await f.close();
  }
});
test("trusted ESM package can load while service is running", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "plugins", "test");
    await mkdir(directory);
    await Bun.write(
      join(directory, "plugin.json"),
      JSON.stringify({
        id: "external.path",
        version: "1",
        kind: "path",
        apiVersion: 1,
        entry: "index.js",
      }),
    );
    await Bun.write(
      join(directory, "index.js"),
      `export default {id:'external.path',defaultLocale:"en-US",nameKey:"package.name",messages:{"en-US":{"package.name":'external'}},version:'1',kind:'path',apiVersion:1,configSchemaVersion:1,configSchema:{type:'object'},async createInstance(){return {async generate(){return {logicalKey:'external.png'}}}}}`,
    );
    await f.app.plugins.loadPackage(directory);
    const record = await f.app.plugins.save({
      pluginId: "external.path",
      version: "1",
      name: "external",
      config: {},
    });
    const lease = f.app.plugins.acquire(record.id, "path");
    expect(
      await lease.runtime.generate(
        {
          record: {
            id: "x",
            createdAt: 0,
            origin: { kind: "upload" as const, userId: null },
            ownerId: null,
            organization: { tags: [], collections: [] },
          },
          metadata: { mimeType: "image/png", byteSize: 1, width: 1, height: 1 },
        },
        context(),
      ),
    ).toEqual({ logicalKey: "external.png" });
    await lease.release();
    const owner = await f.app.configuration.profile(f.profileId);
    await f.app.configuration.saveProfile(
      {
        ...owner,
        pathInstanceId: record.id,
        expectedVersion: owner.configVersion,
      },
      owner.id,
    );
    await f.restart();
    const again = f.app.plugins.acquire(record.id, "path");
    await again.release();
  } finally {
    await f.close();
  }
});
test("cacheable false executes every request; normal processor result is cached", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const def: Definition<"processor"> = {
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "counter" } },

      id: "test.counter",

      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        access: {
          configSchemaVersion: 1,
          configSchema: {
            type: "object",
            properties: { cache: { type: "boolean", default: false } },
            additionalProperties: false,
          },
          async createInstance({ config }) {
            return {
              cacheable: config.cache as boolean,
              async process() {
                calls++;
                return { status: "pass" };
              },
            };
          },
        },
      },
    };
    f.app.plugins.register(def);
    const record = await f.app.plugins.save({
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "counter",
      config: { cache: false },
    });
    await f.app.db.transaction(async (r) =>
      r.insertStep({
        ...entity(),
        enabled_params: [],
        pipeline_id: (await r.accessPipeline())!.id,
        position: 1,
        plugin_instance_id: record.id,
        on_not_applicable: "abort",
      }),
    );
    const v = await (await f.upload()).json();
    const path = new URL(v.url).pathname + "?w=10";
    await (await f.request(path)).arrayBuffer();
    await (await f.request(path)).arrayBuffer();
    expect(calls).toBe(2);
    await f.app.plugins.save({
      id: record.id,
      pluginId: def.id,
      stage: "access",
      version: "1",
      name: "counter",
      config: { cache: true },
      expectedVersion: 1,
    });
    await (await f.request(path)).arrayBuffer();
    await (await f.request(path)).arrayBuffer();
    expect(calls).toBe(3);
  } finally {
    await f.close();
  }
});
