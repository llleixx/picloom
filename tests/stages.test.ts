import type { ParamsSchema } from "../plugin-sdk/schema";
import { test, expect, spyOn } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
import { requestParameters, parseQuery } from "../src/core/request-params";
import { cacheKey } from "../src/core/cache";
import { entity } from "../src/persistence/port";
import { instance } from "./persistence.contract";
import { assertParamsSchema } from "../shared/params-schema";
const plugin = {
  pluginId: "builtin.sharp",
  version: "1.0.0",
  config: { allowEnlargement: false },
  onNotApplicable: "abort" as const,
};

test("stage definitions filter support; upload Sharp transforms the stored original", async () => {
  const f = await fixture();
  try {
    const summaries = await (await f.request("/api/plugins")).json();
    expect(
      summaries.find((p: any) => p.id === "builtin.tencent-moderation"),
    ).toMatchObject({ kind: "processor", supportedStages: ["post_save"] });
    const view = await (
      await f.request("/api/plugins/builtin.sharp/versions/1.0.0")
    ).json();
    expect(view.configSchema).toBeUndefined();
    expect(view.stages.upload.configSchema.properties.w.type).toBe("integer");
    expect(view.stages.access.paramsSchema.properties.w.type).toBe("integer");
    expect(
      (
        await f.request("/api/pipelines", "POST", {
          name: "Wrong",
          kind: "upload",
          steps: [
            {
              pluginId: "builtin.tencent-moderation",
              version: "1.0.0",
              config: {
                region: "ap-guangzhou",
                submissionMode: "content",
                maxContentMiB: 5,
                blockAction: "block",
                timeoutMs: 30000,
                interval: 5,
                maxFrames: 5,
              },
              onNotApplicable: "abort",
            },
          ],
        })
      ).status,
    ).toBe(400);
    const chain = await f.app.configuration.savePipeline({
      name: "Resize",
      kind: "upload",
      steps: [{ ...plugin, config: { w: 16, format: "webp", q: 70 } }],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        uploadPipelineId: chain.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const upload = await f.upload();
    expect(upload.status).toBe(201);
    const file = await upload.json();
    const m = await sharp(
      Buffer.from(
        await (await f.request(new URL(file.url).pathname)).arrayBuffer(),
      ),
    ).metadata();
    expect(m.width).toBe(16);
    expect(m.height).toBe(8);
    expect(m.format).toBe("webp");
    expect(new URL(file.url).pathname).toEndWith(".webp");
    await f.restart();
    expect((await f.upload()).status).toBe(201);
  } finally {
    await f.close();
  }
});

test("access settings and enabled query selection are independent and survive restart", async () => {
  const f = await fixture();
  try {
    let access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    access = await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            ...access.steps[0]!,
            config: { allowEnlargement: true },
            enabledParams: ["w"],
          },
        ],
      },
      access.id,
    );
    const file = await (await f.upload()).json(),
      path = new URL(file.url).pathname;
    const read = spyOn(f.app.files as any, "read");
    expect((await f.request(path + "?w=bad")).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    const unknown = await f.request(path + "?unrelated=value");
    expect(unknown.status).toBe(200);
    await unknown.arrayBuffer();
    expect(read.mock.calls[0]![1]).toBe("auto");
    read.mockClear();
    const get = async (q: string) => {
      const r = await f.request(path + q);
      expect(r.status).toBe(200);
      return sharp(Buffer.from(await r.arrayBuffer())).metadata();
    };
    expect((await get("?w=80&q=bad&q=duplicate")).width).toBe(80);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await get("?w=080&unrelated=other")).width).toBe(80);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
    expect((await f.request(path + "?w=bad")).status).toBe(400);
    expect((await f.request(path + "?w=10&w=20")).status).toBe(400);
    expect(
      (
        await f.request("/api/pipelines/" + access.id, "PUT", {
          ...access,
          expectedVersion: access.configVersion,
          steps: [{ ...access.steps[0], enabledParams: ["typo"] }],
        })
      ).status,
    ).toBe(400);
    access = await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            ...access.steps[0]!,
            config: { allowEnlargement: false },
            enabledParams: ["w"],
          },
        ],
      },
      access.id,
    );
    expect((await get("?w=80&q=bad&q=duplicate")).width).toBe(40);
    access = await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [{ ...access.steps[0]!, enabledParams: [] }],
      },
      access.id,
    );
    expect((await get("?w=bad")).width).toBe(40);
    await f.restart();
    expect((await get("?w=bad")).width).toBe(40);
  } finally {
    await f.close();
  }
});

test("core parses declared scalars only and query permissions participate in cache identity", async () => {
  const schema: ParamsSchema = {
    type: "object",
    properties: {
      flag: { type: "boolean" },
      degree: { type: "number", minimum: -90, maximum: 90 },
      label: { type: "string", minLength: 1 },
    },
  };
  assertParamsSchema(schema);
  expect(
    requestParameters(
      schema,
      ["flag", "degree"],
      parseQuery(new URLSearchParams("flag=false&degree=1.5&ignored=bad")),
    ),
  ).toEqual({ flag: false, degree: 1.5 });
  expect(() =>
    requestParameters(
      schema,
      ["flag"],
      parseQuery(new URLSearchParams("flag=0")),
    ),
  ).toThrow();
  expect(() =>
    assertParamsSchema({
      type: "object",
      properties: { x: { type: "array", items: { type: "string" } } },
    }),
  ).toThrow();
  const record = instance(),
    step = {
      ...entity(),
      pipeline_id: "access",
      position: 0,
      plugin_instance_id: record.id,
      on_not_applicable: "abort" as const,
      enabled_params: ["w", "h"],
    };
  const key = await cacheKey(
    "file",
    parseQuery(new URLSearchParams("w=10&h=20")),
    [{ record, step }],
  );
  expect(
    await cacheKey("file", parseQuery(new URLSearchParams("h=20&w=10")), [
      { record, step },
    ]),
  ).toBe(key);
  expect(
    await cacheKey("file", parseQuery(new URLSearchParams("w=10&h=20")), [
      { record, step: { ...step, enabled_params: ["w"] } },
    ]),
  ).not.toBe(key);
});

test("multipart params override enabled upload settings only; malformed requests never publish", async () => {
  const f = await fixture();
  try {
    const chain = await f.app.configuration.savePipeline({
      name: "Upload parameters",
      kind: "upload",
      steps: [
        { ...plugin, config: { w: 16, format: "webp" }, enabledParams: ["w"] },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        uploadPipelineId: chain.id,
      },
      profile.id,
    );
    const send = (params?: string | Blob, duplicate = false) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(f.png)], "test.png"));
      form.set("profileId", f.profileId);
      if (params !== undefined) form.append("params", params);
      if (duplicate) form.append("params", "{}");
      return f.request("/api/files", "POST", form);
    };
    const check = async (params: string | undefined, width: number) => {
      const response = await send(params);
      expect(response.status).toBe(201);
      const value = await response.json();
      const metadata = await sharp(
        Buffer.from(
          await (await f.request(new URL(value.url).pathname)).arrayBuffer(),
        ),
      ).metadata();
      expect(metadata.width).toBe(width);
      expect(metadata.format).toBe("webp");
    };
    await check(undefined, 16);
    await check('{"w":8,"format":"png","allowEnlargement":true}', 8);
    await check('{"w":80,"allowEnlargement":true}', 40);
    const count = async () =>
      (await (await f.request("/api/files")).json()).length;
    const before = await count();
    for (const bad of ["{", "[]", "null", '{"w":"8"}', '{"w":0}', '{"w":{}}']) {
      const response = await send(bad);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_PARAMS");
    }
    expect((await send(new Blob(["{}"]))).status).toBe(400);
    expect((await send("{}", true)).status).toBe(400);
    expect(await count()).toBe(before);
    await f.restart();
    await check('{"w":10}', 10);
  } finally {
    await f.close();
  }
});

test("cache configuration is only prepared for cacheable image access", async () => {
  const f = await fixture();
  const config = spyOn(f.app.plugins, "cacheConfiguration");
  let lease: ReturnType<typeof f.app.plugins.acquire<"access">> | undefined;
  try {
    const chain = await f.app.configuration.savePipeline({
      name: "Upload transform",
      kind: "upload",
      steps: [{ ...plugin, config: { w: 16 } }],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        uploadPipelineId: chain.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const response = await f.upload();
    expect(response.status).toBe(201);
    const file = await response.json();
    expect(config).not.toHaveBeenCalled();
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    lease = f.app.plugins.acquire(access.steps[0]!.key!, "access");
    expect(config).not.toHaveBeenCalled();
    const read = async (width: number) => {
      const result = await f.request(
        new URL(file.url).pathname + `?w=${width}`,
      );
      expect(result.status).toBe(200);
      return sharp(Buffer.from(await result.arrayBuffer())).metadata();
    };
    expect((await read(8)).width).toBe(8);
    expect(config).toHaveBeenCalledTimes(1);
    config.mockClear();
    lease.runtime.cacheable = false;
    expect((await read(10)).width).toBe(10);
    expect(config).not.toHaveBeenCalled();
  } finally {
    config.mockRestore();
    await lease?.release();
    await f.close();
  }
});
