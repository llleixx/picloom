import { test, expect } from "bun:test";
import { fixture } from "./action-fixture";
const path = () => ({
  pluginId: "builtin.date-path",
  version: "1.0.0",
  config: {},
});
const processor = () => ({
  pluginId: "builtin.sharp",
  version: "1.0.0",
  config: {},
  onNotApplicable: "abort" as const,
});
test("pipelines own encrypted settings, share references, duplicate independently and reject stale or invalid edits", async () => {
  const f = await fixture();
  try {
    const before = (await f.app.db.read((r) => r.instances())).length;
    expect(
      (
        await f.request("/api/pipelines", "POST", {
          name: "Invalid",
          kind: "post_save",
          steps: [
            {
              pluginId: "test.action",
              version: "1.0.0",
              config: { url: "invalid" },
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await f.app.db.read((r) => r.instances())).length).toBe(before);
    let chain = await f.app.configuration.savePipeline({
      name: "Notify",
      kind: "post_save",
      steps: [
        {
          pluginId: "test.action",
          version: "1.0.0",
          config: { url: "http://localhost/hook" },
          secretEdits: {
            "/token": { action: "replace", value: "owned-secret" },
          },
        },
      ],
    });
    const key = chain.steps[0]!.key!;
    expect(JSON.stringify(chain)).not.toContain("owned-secret");
    expect(chain.steps[0]!.secretPresence?.["/token"]).toBe(true);
    const record = (await f.app.db.read((r) => r.instance(key)))!;
    expect(record.secrets_encrypted).not.toContain("owned-secret");
    await f.app.db.transaction((r) =>
      r.updateState(key, { fresh: true }, record.state_version),
    );
    const stale = chain.configVersion;
    chain = await f.app.configuration.savePipeline(
      {
        ...chain,
        expectedVersion: stale,
        steps: [
          {
            ...chain.steps[0]!,
            config: { url: "http://localhost/second" },
            secretEdits: { "/token": { action: "preserve" } },
          },
        ],
      },
      chain.id,
    );
    expect(
      (await f.app.db.read((r) => r.instance(key)))!.state_json.fresh,
    ).toBe(true);
    expect(
      (
        await f.request("/api/pipelines/" + chain.id, "PUT", {
          ...chain,
          expectedVersion: stale,
        })
      ).status,
    ).toBe(409);
    const copy = await f.app.configuration.duplicatePipeline(chain.id);
    expect(copy.steps[0]!.key).not.toBe(key);
    expect(copy.steps[0]!.secretPresence?.["/token"]).toBe(true);
    expect(
      (await f.app.db.read((r) => r.instance(copy.steps[0]!.key!)))!.state_json,
    ).toEqual({});
    expect(
      (
        await f.request("/api/pipelines/" + copy.id, "PUT", {
          ...copy,
          expectedVersion: copy.configVersion,
          steps: chain.steps,
        })
      ).status,
    ).toBe(400);
    let profile = await f.app.configuration.profileEditor(f.profileId);
    profile = await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: chain.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const another = await f.app.configuration.saveProfileEditor({
      ...profile,
      name: "Other",
      path: path(),
    });
    expect(
      (await f.app.configuration.pipeline(chain.id)).references,
    ).toHaveLength(2);
    expect(
      (await f.request("/api/pipelines/" + chain.id, "DELETE")).status,
    ).toBe(409);
    expect(
      (
        await f.request("/api/upload-profiles/" + profile.id, "PUT", {
          ...profile,
          uploadPipelineId: chain.id,
          expectedVersion: profile.configVersion,
        })
      ).status,
    ).toBe(400);
    await f.app.configuration.deleteProfile(another.id);
    expect(
      await f.app.db.read((r) => r.instance(another.path.key!)),
    ).toBeNull();
    expect(await f.app.db.read((r) => r.instance(key))).not.toBeNull();
    profile = await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: null,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    await f.app.configuration.deletePipeline(chain.id);
    expect(await f.app.db.read((r) => r.instance(key))).toBeNull();
    expect(
      await f.app.db.read((r) => r.instance(copy.steps[0]!.key!)),
    ).not.toBeNull();
    expect(
      (await f.request("/api/storage-sources/" + profile.path.key)).status,
    ).toBe(404);
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    expect(
      (await f.request("/api/pipelines/" + access.id, "DELETE")).status,
    ).toBe(409);
    expect(
      (
        await f.request("/api/pipelines", "POST", {
          name: "Access 2",
          kind: "access",
          steps: [],
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
test("initialization failures keep owner configuration; retrying save recovers and pipeline versions cover plugin configuration", async () => {
  const f = await fixture();
  try {
    f.app.plugins.register({
      defaultLocale: "en-US",
      content: { "en-US": { name: "Owned" } },

      id: "test.owned",

      kind: "path",
      version: "1",
      apiVersion: 1,
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          fail: { type: "boolean", default: false },
          optional: { type: "string" },
        },
      },
      async createInstance({ config }) {
        if (config.fail) throw Error("private");
        return {
          async generate() {
            return { logicalKey: "owned.png" };
          },
        };
      },
    });
    let p = await f.app.configuration.profileEditor(f.profileId);
    p = await f.app.configuration.saveProfileEditor(
      {
        ...p,
        path: {
          pluginId: "test.owned",
          version: "1",
          config: { fail: true, optional: "remove" },
        },
        expectedVersion: p.configVersion,
      },
      p.id,
    );
    expect(p.path.ready).toBe(false);
    expect(p.path.error).not.toContain("private");
    p = await f.app.configuration.saveProfileEditor(
      {
        ...p,
        path: { ...p.path, config: { fail: false } },
        expectedVersion: p.configVersion,
      },
      p.id,
    );
    expect(p.path.ready).toBe(true);
    expect(p.path.config.optional).toBeUndefined();
    let access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    const oldVersion = access.configVersion;
    access = await f.app.configuration.savePipeline(
      {
        ...access,
        steps: [{ ...processor(), config: { allowEnlargement: false } }],
        expectedVersion: access.configVersion,
      },
      access.id,
    );
    expect(access.configVersion).not.toBe(oldVersion);
    expect(
      (
        await f.request("/api/pipelines/" + access.id, "PUT", {
          ...access,
          steps: [],
          expectedVersion: oldVersion,
        })
      ).status,
    ).toBe(409);
    const key = access.steps[0]!.key!,
      configurationVersion = access.configVersion;
    access = await f.app.configuration.savePipeline(
      {
        ...access,
        steps: [{ ...access.steps[0]!, config: { allowEnlargement: true } }],
        expectedVersion: access.configVersion,
      },
      access.id,
    );
    expect(access.steps[0]!.key).toBe(key);
    expect(access.configVersion).not.toBe(configurationVersion);
    await f.app.configuration.savePipeline(
      {
        ...access,
        steps: [],
        expectedVersion: access.configVersion,
      },
      access.id,
    );
    expect(await f.app.db.read((r) => r.instance(key))).toBeNull();
    p = await f.app.configuration.saveProfileEditor(
      { ...p, path: path(), expectedVersion: p.configVersion },
      p.id,
    );
    await f.restart();
    expect((await f.app.configuration.profileEditor(p.id)).path.ready).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});
test("removed steps are deleted immediately and pending pipelines use current steps after restart", async () => {
  const f = await fixture();
  const receiver = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, { status: 204 });
    },
  });
  try {
    let p = await f.app.configuration.profileEditor(f.profileId);
    const chain = await f.app.configuration.savePipeline({
      name: "Notify",
      kind: "post_save",
      steps: [
        {
          pluginId: "test.action",
          version: "1.0.0",
          config: { url: receiver.url.href },
        },
      ],
    });
    p = await f.app.configuration.saveProfileEditor(
      { ...p, postSavePipelineId: chain.id, expectedVersion: p.configVersion },
      p.id,
    );
    const response = await f.upload();
    expect(response.status).toBe(201);
    const file = await response.json();
    const key = chain.steps[0]!.key!;
    await f.app.configuration.savePipeline(
      { ...chain, steps: [], expectedVersion: chain.configVersion },
      chain.id,
    );
    expect(await f.app.db.read((r) => r.instance(key))).toBeNull();
    await f.restart();
    expect(await f.app.db.read((r) => r.instance(key))).toBeNull();
    const tasks = await f.app.db.read((r) => r.tasks(file.id));
    expect(tasks[0]?.status).toBe("success");
    expect(tasks[0]?.last_error).toBeNull();
    expect((await f.app.db.read((r) => r.file(file.id)))?.status).toBe("ready");
  } finally {
    await receiver.stop(true);
    await f.close();
  }
});

test("removing a running action deletes configuration immediately while the acquired runtime finishes", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let disposed = false;
  f.app.plugins.register({
    defaultLocale: "en-US",
    content: { "en-US": { name: "Running" } },

    id: "test.running-action",

    kind: "processor",
    version: "1",
    apiVersion: 1,
    stages: {
      post_save: {
        defaultLocale: "en-US",
        content: { "en-US": {} },

        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance() {
          return {
            async execute() {
              started.resolve();
              await finish.promise;
              return { status: "pass" };
            },
            async dispose() {
              disposed = true;
            },
          };
        },
      },
    },
  });
  try {
    let p = await f.app.configuration.profileEditor(f.profileId);
    const chain = await f.app.configuration.savePipeline({
      name: "Notify",
      kind: "post_save",
      steps: [{ pluginId: "test.running-action", version: "1", config: {} }],
    });
    p = await f.app.configuration.saveProfileEditor(
      { ...p, postSavePipelineId: chain.id, expectedVersion: p.configVersion },
      p.id,
    );
    const file = await (await f.upload()).json();
    const pending = f.app.files.sweep();
    await started.promise;
    const key = chain.steps[0]!.key!;
    await f.app.configuration.savePipeline(
      { ...chain, steps: [], expectedVersion: chain.configVersion },
      chain.id,
    );
    expect(await f.app.db.read((r) => r.instance(key))).toBeNull();
    expect(disposed).toBe(false);
    finish.resolve();
    await pending;
    expect(disposed).toBe(true);
    expect((await f.app.db.read((r) => r.tasks(file.id)))[0]?.status).toBe(
      "success",
    );
  } finally {
    finish.resolve();
    await f.close();
  }
});

test("shared pipeline edits affect future uploads and changed in-flight plans never publish", async () => {
  let change: (() => Promise<void>) | undefined;
  const f = await fixture({
    beforePublish: async () => {
      const fn = change;
      change = undefined;
      await fn?.();
    },
  });
  try {
    let chain = await f.app.configuration.savePipeline({
      name: "Upload limits",
      kind: "upload",
      steps: [processor()],
    });
    const p = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      { ...p, uploadPipelineId: chain.id, expectedVersion: p.configVersion },
      p.id,
    );
    expect((await f.upload()).status).toBe(201);
    change = async () => {
      chain = await f.app.configuration.savePipeline(
        {
          ...chain,
          name: "Updated limits",
          expectedVersion: chain.configVersion,
        },
        chain.id,
      );
    };
    expect((await f.upload()).status).toBe(409);
    const failed = (
      await f.app.db.read((r) => r.filesInStates(["failed"]))
    )[0]!;
    expect(failed).toBeDefined();
    expect(
      (await f.request(failed.public_prefix + failed.logical_key)).status,
    ).toBe(404);
    chain = await f.app.configuration.savePipeline(
      { ...chain, steps: [], expectedVersion: chain.configVersion },
      chain.id,
    );
    await f.restart();
    expect((await f.app.configuration.pipeline(chain.id)).steps).toEqual([]);
    expect((await f.upload()).status).toBe(201);
  } finally {
    await f.close();
  }
});
