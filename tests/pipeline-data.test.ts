import { test, expect } from "bun:test";
import { pipelineData } from "../src/core/pipeline-data";
import { fixture } from "./helpers";
import {
  type Definition,
  type PipelineContext,
  type Config,
  type Json,
} from "../src/plugins/api";

test("execution data copies JSON values and enforces a total size limit", () => {
  const data = pipelineData(),
    value = { items: [1] };
  data.set("example", value);
  value.items.push(2);
  const read = data.get("example") as typeof value;
  read.items.push(3);
  expect(data.get("example")).toEqual({ items: [1] });
  expect(() => data.set("large", "x".repeat(256 * 1024))).toThrow();
  expect(data.get("large")).toBeUndefined();
  expect(() => data.set("bad", NaN)).toThrow();
  expect(pipelineData().get("example")).toBeUndefined();
  for (const value of [
    new Date(),
    new Map(),
    Object.defineProperty({}, "toJSON", { value: () => "converted" }),
    new Set(),
    new Uint8Array(1),
    new (class Value {
      n = 1;
    })(),
    { nested: new Date() },
    {
      toJSON() {
        throw new Error("must not run");
      },
    },
  ])
    expect(() => data.set("example", value as unknown as Json)).toThrow(
      "Expected JSON pipeline data",
    );
  expect(data.get("example")).toEqual({ items: [1] });
  data.set(
    "null-prototype",
    Object.assign(Object.create(null), { valid: true }),
  );
  expect(data.get("null-prototype")).toEqual({ valid: true });
});

test("all stages share data within an attempt; failed actions release sources and retained steps keep identity", async () => {
  const f = await fixture();
  let fail = true;
  const calls: string[] = [];
  const schema: Config = {
    type: "object",
    properties: { role: { type: "string", enum: ["produce", "consume"] } },
    required: ["role"],
  };
  const run = (stage: string, role: string, ctx: PipelineContext) => {
    calls.push(stage + ":" + role);
    if (role === "produce") {
      expect(ctx.data.get("example")).toBeUndefined();
      ctx.data.set("example", { value: 7 });
    } else {
      expect(ctx.data.get("example")).toEqual({ value: 7 });
      if (stage === "post_save" && fail)
        throw Object.assign(new Error("sensitive-error-detail"), {
          name: "PluginError",
          code: "EXTERNAL_PRIVATE_CODE",
          retryable: false,
          outcome: "unknown",
        });
    }
  };
  const transform = (stage: string) => ({
    configSchemaVersion: 1,
    configSchema: schema,
    paramsSchema: {
      type: "object",
      properties: { run: { type: "boolean" } },
    } as Config,
    async createInstance({ config }: { config: Readonly<Config> }) {
      return {
        async check(
          _input: unknown,
          ctx: import("../src/plugins/api").CheckContext,
        ) {
          expect("set" in ctx.data).toBe(false);
          expect("createOutput" in (_input as object)).toBe(false);
          return { status: "applicable" as const };
        },
        async process(_input: unknown, ctx: PipelineContext) {
          expect("createOutput" in (_input as object)).toBe(true);
          run(stage, String(config.role), ctx);
          return { status: "pass" as const };
        },
      };
    },
  });
  const def: Definition<"processor"> = {
    id: "test.data",
    name: "Data",
    version: "1",
    apiVersion: 1,
    kind: "processor",
    stages: {
      upload: transform("upload"),
      access: transform("access"),
      post_save: {
        configSchemaVersion: 1,
        configSchema: schema,
        async createInstance({ config }) {
          return {
            async execute(_input, ctx) {
              run("post_save", String(config.role), ctx);
              return { status: "pass" };
            },
          };
        },
      },
    },
  };
  try {
    f.app.plugins.register(def);
    const steps = (action = false) =>
      ["produce", "consume"].map((role) => ({
        pluginId: def.id,
        version: "1",
        config: { role },
        ...(action
          ? {}
          : { onNotApplicable: "abort" as const, enabledParams: ["run"] }),
      }));
    const upload = await f.app.configuration.savePipeline({
      name: "Upload data",
      kind: "upload",
      steps: steps(),
    });
    let post = await f.app.configuration.savePipeline({
      name: "Post data",
      kind: "post_save",
      steps: steps(true),
    });
    const before = await f.app.db.read((r) => r.steps(post.id));
    post = await f.app.configuration.savePipeline(
      { ...post, name: "Edited", expectedVersion: post.configVersion },
      post.id,
    );
    expect(
      (await f.app.db.read((r) => r.steps(post.id))).map((s) => s.id),
    ).toEqual(before.map((s) => s.id));
    post = await f.app.configuration.savePipeline(
      {
        ...post,
        steps: [...post.steps].reverse(),
        expectedVersion: post.configVersion,
      },
      post.id,
    );
    expect(
      (await f.app.db.read((r) => r.steps(post.id))).map((s) => s.id),
    ).toEqual(before.map((s) => s.id).reverse());
    post = await f.app.configuration.savePipeline(
      {
        ...post,
        steps: [...post.steps].reverse(),
        expectedVersion: post.configVersion,
      },
      post.id,
    );
    let access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      { ...access, steps: steps(), expectedVersion: access.configVersion },
      access.id,
    );
    let profile = await f.app.configuration.profileEditor(f.profileId);
    profile = await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        uploadPipelineId: upload.id,
        postSavePipelineId: post.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const file = await (await f.upload()).json();
    const path = new URL(file.url).pathname;
    await (await f.request(path + "?run=true")).arrayBuffer();
    await f.app.files.sweep();
    const tasks = await f.app.db.read((r) => r.tasks(file.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("failed");
    const operations = await (
      await f.request(`/api/files/${file.id}/operations`)
    ).json();
    expect(operations.tasks[0]).toMatchObject({
      error: "PLUGIN_FAILED",
      failedStep: { id: before[1]!.id, name: "Data" },
    });
    expect(JSON.stringify(operations)).not.toContain("sensitive-error-detail");
    fail = false;
    await expect(f.app.files.tasks.retry(tasks[0]!.id)).rejects.toThrow();
    await f.app.files.sweep();
    expect(calls).toEqual([
      "upload:produce",
      "upload:consume",
      "access:produce",
      "access:consume",
      "post_save:produce",
      "post_save:consume",
    ]);
    expect((await f.app.db.read((r) => r.file(file.id)))!.temp_path).toBeNull();
    const another = await (await f.upload()).json();
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: null,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    await f.app.configuration.deletePipeline(post.id);
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.tasks(another.id)))[0]?.last_error,
    ).toBe("PIPELINE_MISSING");
  } finally {
    await f.close();
  }
});
