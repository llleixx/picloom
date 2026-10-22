import { expect, test } from "bun:test";
import {
  assertSchema,
  initialConfig,
  initialValue,
  type Config,
} from "../shared/config";
import { PluginManager } from "../src/plugins/manager";
import { Secrets } from "../src/infra/secrets";
import type { ConfigSchema, ParamsSchema } from "@picloom/plugin-sdk";
import type { Definition } from "@picloom/plugin-sdk";
import type { Instance, Persistence } from "../src/persistence/port";
import { configuration, manifest, validateField } from "../src/themes/schema";
import { requestParameters } from "../src/core/request-params";

const definition = (schema: unknown, version = "1"): Definition<"path"> => ({
  id: "test.protocol",
  version,
  kind: "path",
  apiVersion: 1,
  nameKey: "name",
  defaultLocale: "en-US",
  messages: { "en-US": { name: "Protocol" } },
  configSchemaVersion: 1,
  configSchema: schema as ConfigSchema,
  async createInstance() {
    throw new Error("Not used in preparation tests");
  },
});
function memoryManager() {
  const records = new Map<string, Instance>();
  const secrets = new Secrets("00".repeat(32));
  const db = {
    read: async (fn: any) => fn({ instance: (id: string) => records.get(id) }),
  } as Persistence;
  return {
    records,
    secrets,
    manager: new PluginManager(db, secrets, "/unused"),
  };
}

test("omitted plugin schemas normalize to closed empty objects without changing author declarations", async () => {
  const { manager } = memoryManager();
  const empty: ConfigSchema & ParamsSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const path = definition(empty);
  delete path.configSchema;
  manager.register(path);
  expect(path.configSchema).toBeUndefined();
  const storage: Definition<"storage"> = {
    ...path,
    id: "test.empty-storage",
    kind: "storage",
    async createInstance() {
      throw new Error("Not used");
    },
  };
  manager.register(storage);
  const processor: Definition<"processor"> = {
    id: "test.empty-processor",
    version: "1",
    apiVersion: 1,
    kind: "processor",
    defaultLocale: "en-US",
    nameKey: "name",
    messages: { "en-US": { name: "No custom fields" } },
    stages: {
      upload: {
        configSchemaVersion: 1,
        async createInstance() {
          throw new Error("Not used");
        },
      },
      access: {
        configSchemaVersion: 1,
        async createInstance() {
          throw new Error("Not used");
        },
      },
      post_save: {
        configSchemaVersion: 1,
        async createInstance() {
          throw new Error("Not used");
        },
      },
    },
  };
  manager.register(processor);
  expect(processor.stages.access!.configSchema).toBeUndefined();
  expect(processor.stages.access!.paramsSchema).toBeUndefined();
  for (const view of manager.definitionsView()) {
    const stages =
      view.kind === "processor"
        ? Object.entries(view.stages)
        : [[undefined, view] as const];
    for (const [stage, desc] of stages) {
      expect(desc!.configSchema).toEqual(empty);
      const input = {
        pluginId: view.id,
        version: view.version,
        name: "Empty",
        stage: stage as import("@picloom/plugin-sdk").Stage | undefined,
      };
      expect(
        (await manager.prepare({ ...input, config: {} })).record.config_json,
      ).toEqual({});
      await expect(
        manager.prepare({ ...input, config: { unexpected: true } }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      if (stage === "upload" || stage === "access") {
        expect("paramsSchema" in desc! && desc.paramsSchema).toEqual(empty);
        expect(
          requestParameters(
            "paramsSchema" in desc! ? desc.paramsSchema : undefined,
            [],
            { unexpected: true },
            "body",
          ),
        ).toEqual({});
      } else expect(desc).not.toHaveProperty("paramsSchema");
    }
  }
});

test("only omitted schemas gain an empty schema; invalid declarations and unsupported stages still fail", () => {
  for (const bad of [null, false, [], {}, { type: "string" }]) {
    const { manager } = memoryManager();
    expect(() => manager.register(definition(bad as any))).toThrow();
    expect(() =>
      manager.register({
        ...definition({ type: "object" }),
        kind: "processor",
        stages: {
          access: {
            configSchemaVersion: 1,
            paramsSchema: bad,
            async createInstance() {},
          },
        },
      } as any),
    ).toThrow();
  }
  const { manager } = memoryManager();
  expect(() =>
    manager.register({
      ...definition({ type: "object" }),
      kind: "processor",
      stages: {
        post_save: {
          configSchemaVersion: 1,
          paramsSchema: { type: "object" },
          async createInstance() {},
        },
      },
    } as any),
  ).toThrow("Invalid plugin declaration (post_save)");
  const noConfig = definition({ type: "object" });
  delete noConfig.configSchema;
  expect(() =>
    manager.register({
      ...noConfig,
      kind: "storage",
      localDirectory: { configPath: "/root" },
    } as any),
  ).toThrow();
});

test("omitted theme schemas normalize like plugin schemas and reject undeclared configuration", () => {
  const input = {
    id: "test.no-config",
    version: "1",
    apiVersion: 1,
    defaultLocale: "en-US",
    supportedLocales: ["en-US"],
    nameKey: "name",
    messages: { "en-US": { name: "No custom configuration" } },
    pages: { home: { entry: "entry.js" } },
  };
  const normalized = manifest(input);
  expect(input).not.toHaveProperty("configSchema");
  expect(normalized.configSchema).toEqual({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  expect(
    manifest({
      ...input,
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }),
  ).toEqual(normalized);
  expect(
    configuration(normalized.configSchema, undefined, true, false),
  ).toEqual({});
  for (const complete of [false, true]) {
    expect(configuration(normalized.configSchema, {}, false, complete)).toEqual(
      {},
    );
    expect(() =>
      configuration(
        normalized.configSchema,
        { unexpected: true },
        false,
        complete,
      ),
    ).toThrow();
  }
  for (const configSchema of [null, false, [], {}, { type: "string" }])
    expect(() => manifest({ ...input, configSchema })).toThrow();
});

test("constraint branches only constrain declared fields and cannot change storage or UI", () => {
  const base: Config = {
    type: "object",
    properties: {
      token: { type: "string" },
      items: { type: "array", items: { type: "string" } },
    },
  };
  for (const branch of [
    { properties: { token: { "x-sensitive": true } } },
    { properties: { token: { "x-ui": { labelKey: "name" } } } },
    { properties: { token: { default: "sample" } } },
    { properties: { missing: { type: "string" } } },
    { properties: { toString: { const: "x" } } },
    { properties: { valueOf: { const: "x" } } },
    { properties: { hasOwnProperty: { const: "x" } } },
    { required: ["missing"] },
    { properties: { token: { items: { type: "string" } } } },
  ]) {
    for (const key of ["allOf", "if", "then", "else"]) {
      const schema = {
        ...base,
        [key]: key === "allOf" ? [branch] : branch,
      } as Config;
      expect(() => assertSchema(schema)).toThrow();
    }
  }
  const { manager } = memoryManager();
  expect(() =>
    manager.register(
      definition({
        ...base,
        allOf: [{ properties: { token: { "x-sensitive": true } } }],
      }),
    ),
  ).toThrow("/allOf/0/properties/token");
  expect(() =>
    assertSchema({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", "x-immutable": true } },
      },
    }),
  ).toThrow("containing array");
  expect(() =>
    assertSchema({
      ...base,
      allOf: [
        {
          if: { properties: { token: { const: "on" } } },
          then: { required: ["items"] },
        },
      ],
    }),
  ).not.toThrow();
});

test("draft defaults preserve explicit falsy values and never supply sensitive values", () => {
  const schema: Config = {
    type: "object",
    properties: {
      text: { type: "string", default: "" },
      flag: { type: "boolean", default: false },
      number: { type: "number", default: 0 },
      list: { type: "array", items: { type: "string" }, default: [] },
      group: {
        type: "object",
        properties: { label: { type: "string", default: "nested" } },
      },
      token: { type: "string", "x-sensitive": true },
      absent: { type: "string" },
    },
  };
  expect(initialConfig(schema)).toEqual({
    text: "",
    flag: false,
    number: 0,
    list: [],
    group: { label: "nested" },
  });
  expect(initialValue({ type: "string" })).toBeUndefined();
  for (const bad of [
    { ...schema, default: { token: "synthetic" } },
    {
      type: "object",
      properties: {
        token: { type: "string", "x-sensitive": true, default: "synthetic" },
      },
    },
    {
      type: "array",
      items: {
        type: "object",
        properties: { token: { type: "string", "x-sensitive": true } },
      },
      default: [{ token: "synthetic" }],
    },
  ])
    expect(() => assertSchema(bad as unknown as Config)).toThrow(
      "Sensitive fields cannot have defaults",
    );
});

test("preparation, secret clearing, copy and upgrade preserve submitted values and omissions", async () => {
  const { manager, records, secrets } = memoryManager();
  const schema: Config = {
    type: "object",
    properties: {
      text: { type: "string", default: "initial" },
      flag: { type: "boolean", default: true },
      number: { type: "number", default: 10 },
      token: { type: "string", "x-sensitive": true },
    },
  };
  manager.register(definition(schema), "external");
  const input = { pluginId: "test.protocol", version: "1", name: "Protocol" };
  const first = await manager.prepare({
    ...input,
    config: { text: "", flag: false, number: 0 },
    secretEdits: { "/token": { action: "replace", value: "synthetic" } },
  });
  expect(first.record.config_json).toEqual({
    text: "",
    flag: false,
    number: 0,
  });
  expect(
    secrets.decrypt(first.record.secrets_encrypted, first.record.id),
  ).toEqual({ token: "synthetic" });
  records.set(first.record.id, first.record);
  const cleared = await manager.prepare({
    ...input,
    id: first.record.id,
    expectedVersion: 1,
    config: {},
    secretEdits: { "/token": { action: "clear" } },
  });
  expect(cleared.record.config_json).toEqual({});
  expect(
    secrets.decrypt(cleared.record.secrets_encrypted, cleared.record.id),
  ).toEqual({});
  records.set(cleared.record.id, cleared.record);
  expect(
    (await manager.prepareCopy(cleared.record.id)).record.config_json,
  ).toEqual({});
  expect(
    (await manager.prepare({ ...input, config: {} })).record.config_json,
  ).toEqual({});
  manager.register(
    definition(
      {
        ...schema,
        properties: {
          ...(schema.properties as Config),
          added: { type: "string", default: "new" },
        },
        required: ["added"],
      },
      "2",
    ),
    "external",
  );
  const preview = await manager.previewUpgrade(cleared.record.id, "2");
  expect(preview.configuration.config).toEqual({});
  expect(preview.fields.some((field) => field.path === "/added")).toBe(true);
  await expect(
    manager.prepare({ ...input, version: "2", config: {} }),
  ).rejects.toThrow();
});

test("conditional requirements still validate without closing condition objects", async () => {
  const { manager } = memoryManager();
  manager.register(
    definition({
      type: "object",
      properties: { mode: { type: "string" }, size: { type: "integer" } },
      allOf: [
        {
          if: { properties: { mode: { const: "resize" } }, required: ["mode"] },
          then: { required: ["size"] },
        },
      ],
    }),
  );
  const input = { pluginId: "test.protocol", version: "1", name: "Protocol" };
  await expect(
    manager.prepare({ ...input, config: { mode: "resize" } }),
  ).rejects.toThrow();
  expect(
    (await manager.prepare({ ...input, config: { mode: "resize", size: 2 } }))
      .record.config_json,
  ).toEqual({ mode: "resize", size: 2 });
});

test("theme declarations reject unusable fields and defaults before configuration", () => {
  for (const field of [
    { type: "string", enum: [1, 2] },
    { type: "integer", enum: [1.5] },
    { type: "number", enum: [Infinity] },
    { type: "number", minimum: 5, maximum: 2 },
    { type: "string", minLength: 2, enum: ["x"] },
    { type: "number", minimum: 2, enum: [1] },
    { type: "object", properties: {}, enum: ["x"] },
    { type: "string", required: [] },
    { type: "boolean", minimum: 1 },
    { type: "number", properties: {} },
    {
      type: "object",
      properties: { hidden: { type: "string", default: 123 } },
    },
    { type: "string", "x-localized": true, default: { "en-US": 123 } },
  ])
    expect(() => validateField(field)).toThrow("/configSchema");
  const schema = {
    type: "object" as const,
    properties: {
      optional: { type: "integer" as const, default: 4 },
      required: { type: "string" as const },
    },
    required: ["required"],
  };
  expect(() => validateField(schema)).not.toThrow();
  expect(configuration(schema, { required: "" })).toEqual({ required: "" });
});

test("package catalogs reject stage metadata and declaration errors identify fields without values", () => {
  const { manager } = memoryManager();
  const path = definition({
    type: "object",
    properties: {
      value: {
        type: "string",
        "x-ui": { labelKey: "unlisted" },
        default: "private-default",
      },
    },
  });
  let error: unknown;
  try {
    manager.register(path);
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("/configSchema/properties/value");
  expect(String(error)).not.toContain("private-default");
  expect(() =>
    manager.register({
      id: "test.stage",
      version: "1",
      kind: "processor",
      apiVersion: 1,
      nameKey: "name",
      defaultLocale: "en-US",
      messages: { "en-US": { name: "Stage" } },
      stages: {
        post_save: {
          defaultLocale: "en-US",
          messages: { "en-US": {} },
          configSchemaVersion: 1,
          configSchema: { type: "object" },
          async createInstance() {
            return {
              async execute() {
                return { status: "pass" };
              },
            };
          },
        },
      },
    } as any),
  ).toThrow("Stage localization");
  for (const legacy of ["content", "uiHints", "translations"]) {
    expect(() =>
      manager.register({
        ...definition({ type: "object" }),
        kind: "processor",
        stages: {
          post_save: {
            [legacy]: {},
            configSchemaVersion: 1,
            configSchema: { type: "object" },
            async createInstance() {
              return {
                async execute() {
                  return { status: "pass" };
                },
              };
            },
          },
        },
      } as any),
    ).toThrow("Stage localization");
  }
  expect(() =>
    assertSchema({
      type: "array",
      items: { type: "string", "x-sensitive": true },
      default: [],
    }),
  ).toThrow("Sensitive fields cannot have defaults");
});

test("static sensitive arrays and immutable arrays keep their storage and edit guarantees", async () => {
  const { manager, records, secrets } = memoryManager();
  manager.register(
    definition({
      type: "object",
      properties: {
        credentials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              token: { type: "string", "x-sensitive": true },
              label: { type: "string" },
            },
          },
        },
        locations: {
          type: "array",
          "x-immutable": true,
          items: { type: "string" },
        },
      },
    }),
  );
  const input = { pluginId: "test.protocol", version: "1", name: "Protocol" };
  const values = [{ token: "synthetic", label: "sample" }];
  const first = await manager.prepare({
    ...input,
    config: { locations: ["a"] },
    secretEdits: { "/credentials": { action: "replace", value: values } },
  });
  expect(first.record.config_json).toEqual({ locations: ["a"] });
  expect(
    secrets.decrypt(first.record.secrets_encrypted, first.record.id),
  ).toEqual({ credentials: values });
  records.set(first.record.id, first.record);
  await expect(
    manager.prepare({
      ...input,
      id: first.record.id,
      expectedVersion: 1,
      config: { locations: ["b"] },
    }),
  ).rejects.toThrow();
});

test("theme draft validation preserves dictionaries while complete constraints run per language", () => {
  const schema = {
    type: "object",
    properties: {
      rows: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string", "x-localized": true, minLength: 1 },
            link: { type: "string", format: "uri" },
          },
          required: ["title"],
          if: { properties: { title: { const: "Link" } }, required: ["title"] },
          then: { required: ["link"] },
        },
      },
    },
    required: ["rows"],
  } as import("@picloom/theme-sdk").Field;
  validateField(schema);
  const draft = { rows: [{ title: { "en-US": "Link", "zh-CN": "文字" } }] };
  const original = structuredClone(draft);
  expect(configuration(schema, draft, false, false)).toEqual(draft);
  expect(() =>
    configuration(schema, draft, false, true, ["en-US", "zh-CN"]),
  ).toThrow();
  expect(() =>
    configuration(schema, { rows: [{ title: { "en-US": "" } }] }, false, false),
  ).toThrow();
  expect(() =>
    configuration(
      schema,
      { rows: [{ title: { "en-US": "Text" } }] },
      false,
      true,
      ["en-US", "zh-CN"],
    ),
  ).toThrow();
  const full = { rows: [{ ...draft.rows[0], link: "https://example.com/" }] };
  expect(configuration(schema, full, false, true, ["en-US", "zh-CN"])).toEqual(
    full,
  );
  expect(draft).toEqual(original);
  expect(configuration(schema, {}, false, false)).toEqual({});
});

test("shared bounds, new composition branches and defaults preserve declaration boundaries", async () => {
  for (const key of ["anyOf", "oneOf", "not"]) {
    const branch = { properties: { value: { default: "forbidden" } } };
    expect(() =>
      assertSchema({
        type: "object",
        properties: { value: { type: "string" } },
        [key]: key === "not" ? branch : [branch],
      }),
    ).toThrow();
  }
  const { manager } = memoryManager();
  const schema: Config = {
    type: "object",
    properties: {
      value: { type: "integer", anyOf: [{ minimum: 2 }, { const: 0 }] },
    },
  };
  manager.register(definition(schema));
  const input = { pluginId: "test.protocol", version: "1", name: "Bounds" };
  expect(
    (await manager.prepare({ ...input, config: { value: 0 } })).record
      .config_json,
  ).toEqual({ value: 0 });
  await expect(
    manager.prepare({ ...input, config: { value: 1 } }),
  ).rejects.toThrow();
  await expect(
    manager.prepare({
      ...input,
      config: { value: Number.MAX_SAFE_INTEGER + 1 },
    }),
  ).rejects.toThrow();
  expect(() =>
    validateField({ type: "string", default: "x".repeat(10001) }),
  ).toThrow();
  expect(() =>
    validateField({ type: "integer", default: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  expect(() =>
    validateField({
      type: "array",
      items: { type: "integer" },
      default: [1, "x"],
    }),
  ).toThrow();
  expect(
    initialValue({
      type: "object",
      properties: { empty: { type: "object", properties: {} } },
    }),
  ).toBeUndefined();
});

test("request defaults only initialize explicitly and scalar transport preserves falsy values", async () => {
  const { assertParamsSchema } = await import("../shared/params-schema");
  const { requestParameters, parseQuery } =
    await import("../src/core/request-params");
  const { sameParameterDefault, sameParameterConstraints } =
    await import("../shared/parameter-fields");
  const schema: ParamsSchema = {
    type: "object",
    properties: {
      text: { type: "string", default: "" },
      flag: { type: "boolean", default: false },
      count: {
        type: "integer",
        default: 0,
        oneOf: [{ const: 0 }, { minimum: 2 }],
      },
    },
  };
  assertParamsSchema(schema);
  expect(
    requestParameters(
      schema,
      ["text", "flag", "count"],
      parseQuery(new URLSearchParams()),
    ),
  ).toEqual({});
  expect(
    requestParameters(
      schema,
      ["text", "flag", "count"],
      parseQuery(new URLSearchParams("text=&flag=false&count=0")),
    ),
  ).toEqual({ text: "", flag: false, count: 0 });
  expect(() =>
    requestParameters(
      schema,
      ["count"],
      parseQuery(new URLSearchParams("count=1")),
    ),
  ).toThrow();
  expect(
    sameParameterConstraints(
      { type: "integer", default: 1, minimum: 0 },
      { minimum: 0, type: "integer", default: 2 },
    ),
  ).toBe(true);
  for (const count of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      requestParameters(schema, ["count"], { count }, "body"),
    ).toThrow();
  expect(sameParameterDefault({ default: false }, {})).toBe(false);
  expect(sameParameterDefault({ default: 0 }, { default: 0 })).toBe(true);
  expect(() => assertParamsSchema({ ...schema, required: ["flag"] })).toThrow();
});

test("declaration checks do not normalize invalid constraints and theme projection retains unknown keys for rejection", () => {
  const { manager } = memoryManager();
  expect(() =>
    manager.register(
      definition({
        type: "object",
        properties: { count: { type: "integer", minimum: "2" } },
      }),
    ),
  ).toThrow();
  expect(() => assertSchema({ type: ["string"] })).toThrow();
  const schema = { type: "object" as const, properties: {} };
  expect(() =>
    configuration(
      schema,
      JSON.parse('{"__proto__":{"value":1}}'),
      false,
      false,
    ),
  ).toThrow();
});

test("explicit theme initialization uses root defaults without creating absent empty groups", () => {
  const schema: import("@picloom/theme-sdk").Field = {
    type: "object",
    default: { title: "Root" },
    properties: {
      title: { type: "string" },
      empty: { type: "object", properties: {} },
    },
  };
  expect(configuration(schema, undefined, true, false)).toEqual({
    title: "Root",
  });
  expect(configuration(schema, {}, false, false)).toEqual({});
  expect(
    configuration({ type: "object", properties: {} }, undefined, true, false),
  ).toEqual({});
});

test("composition enums constrain the full static object without closing partial branch properties", async () => {
  const { manager } = memoryManager();
  manager.register(
    definition({
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      allOf: [
        {
          type: "object",
          properties: { a: { minimum: 1 } },
          enum: [{ a: 1, b: 2 }],
        },
      ],
    }),
  );
  expect(
    (
      await manager.prepare({
        pluginId: "test.protocol",
        version: "1",
        name: "Composition",
        config: { a: 1, b: 2 },
      })
    ).record.config_json,
  ).toEqual({ a: 1, b: 2 });
});

test("themes use shared property names and nesting while keeping language and unsafe-key checks", () => {
  let field: import("@picloom/theme-sdk").Field = {
    type: "string",
    "x-localized": true,
  };
  let value: any = { "en-US": "Text", "zh-CN": "" };
  for (let index = 0; index < 10; index++) {
    const key = index === 0 ? "标题/a~b" : "group " + index;
    field = { type: "object", properties: { [key]: field } };
    value = { [key]: value };
  }
  expect(() => validateField(field)).not.toThrow();
  expect(configuration(field, value, false, true, ["en-US", "zh-CN"])).toEqual(
    value,
  );
  expect(() =>
    validateField({
      type: "object",
      properties: { constructor: { type: "string" } },
    }),
  ).toThrow();
  const localized = {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, "x-localized": true, minLength: 2 },
    },
  };
  expect(() =>
    configuration(localized, { title: { "en-US": "x" } }, false, false),
  ).toThrow();
  expect(() =>
    configuration(localized, { title: { unknown: "Text" } }, false, false),
  ).toThrow();
});

test("sensitivity follows declarations rather than similarly named data inside defaults", async () => {
  const schema: Config = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { "x-sensitive": { type: "boolean" } },
        },
        default: [{ "x-sensitive": true }],
      },
    },
  };
  const { manager } = memoryManager();
  manager.register(definition(schema));
  const config = initialConfig(schema);
  expect(config).toEqual({ items: [{ "x-sensitive": true }] });
  const prepared = await manager.prepare({
    pluginId: "test.protocol",
    version: "1",
    name: "Ordinary data",
    config,
  });
  expect(prepared.record.config_json).toEqual(config);
});

test("absent nested secrets do not create optional groups or replace invalid values", async () => {
  const { manager, records } = memoryManager();
  const schema: Config = {
    type: "object",
    properties: {
      credentials: {
        type: "object",
        properties: { token: { type: "string", "x-sensitive": true } },
        required: ["token"],
      },
    },
  };
  manager.register(definition(schema), "external");
  const input = {
    pluginId: "test.protocol",
    version: "1",
    name: "Optional group",
  };
  const prepared = await manager.prepare({ ...input, config: {} });
  expect(prepared.record.config_json).toEqual({});
  records.set(prepared.record.id, prepared.record);
  manager.register(definition(schema, "2"), "external");
  expect(
    (await manager.previewUpgrade(prepared.record.id, "2")).configuration
      .config,
  ).toEqual({});
  expect(
    (
      await manager.prepare({
        ...input,
        config: {},
        secretEdits: { "/credentials/token": { action: "clear" } },
      })
    ).record.config_json,
  ).toEqual({});
  for (const credentials of [null, false, "", 0, {}])
    await expect(
      manager.prepare({ ...input, config: { credentials } }),
    ).rejects.toThrow();
  const replaced = await manager.prepare({
    ...input,
    config: {},
    secretEdits: {
      "/credentials/token": { action: "replace", value: "test-value" },
    },
  });
  expect(replaced.record.config_json).toEqual({ credentials: {} });
});

test("immutable objects compare values without depending on property insertion order", async () => {
  const { manager, records } = memoryManager();
  manager.register(
    definition({
      type: "object",
      properties: {
        location: {
          type: "object",
          "x-immutable": true,
          properties: {
            bucket: { type: "string" },
            prefix: { type: "string" },
          },
        },
      },
    }),
  );
  const input = {
    pluginId: "test.protocol",
    version: "1",
    name: "Immutable object",
  };
  const first = await manager.prepare({
    ...input,
    config: { location: { bucket: "bucket", prefix: "prefix" } },
  });
  records.set(first.record.id, first.record);
  const update = {
    ...input,
    id: first.record.id,
    expectedVersion: first.record.config_version,
  };
  expect(
    (
      await manager.prepare({
        ...update,
        config: { location: { prefix: "prefix", bucket: "bucket" } },
      })
    ).record.config_json,
  ).toEqual(first.record.config_json);
  await expect(
    manager.prepare({
      ...update,
      config: { location: { prefix: "changed", bucket: "bucket" } },
    }),
  ).rejects.toThrow();
});

test("declared names matching object methods remain absent until explicitly supplied", async () => {
  const { readPointer } = await import("../shared/config");
  const { compileSchema } = await import("../src/core/schema-validation");
  expect(() =>
    assertSchema({
      type: "object",
      properties: { toString: { type: "string" } },
      allOf: [{ properties: { toString: { minLength: 1 } } }],
    }),
  ).not.toThrow();
  const schema: Config = {
    type: "object",
    properties: {
      toString: { type: "string" },
      hasOwnProperty: { type: "boolean", default: false },
      valueOf: {
        type: "object",
        properties: { token: { type: "string", "x-sensitive": true } },
      },
    },
  };
  expect(initialConfig(schema)).toEqual({ hasOwnProperty: false });
  expect(readPointer({}, "/toString")).toBeUndefined();
  expect(readPointer({ toString: "" }, "/toString")).toBe("");
  const { manager } = memoryManager();
  manager.register(definition(schema));
  const input = { pluginId: "test.protocol", version: "1", name: "Own fields" };
  expect(
    (await manager.prepare({ ...input, config: {} })).record.config_json,
  ).toEqual({});
  expect(
    (
      await manager.prepare({
        ...input,
        config: { toString: "", hasOwnProperty: false },
      })
    ).record.config_json,
  ).toEqual({ toString: "", hasOwnProperty: false });
  expect(compileSchema({ ...schema, required: ["toString"] })({})).toBe(false);
  const localized = {
    type: "object" as const,
    properties: { toString: { type: "string" as const, "x-localized": true } },
  };
  validateField(localized);
  expect(configuration(localized, {})).toEqual({});
  expect(configuration(localized, { toString: { "en-US": "" } })).toEqual({
    toString: { "en-US": "" },
  });
});
