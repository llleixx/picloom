import { expect, test } from "bun:test";
import {
  assertPluginContent,
  localizePlugin,
  type PluginLocalization,
} from "../shared/plugin-localization";
import { assertSchema, type PluginView } from "../shared/config";
import { fixture } from "./helpers";
import type { Definition } from "../src/plugins/api";
import { localizedText } from "../plugin-sdk/localization";
import type { AccessParameterGroup } from "../shared/config";

const plugin: PluginView & import("../shared/config").StageView = {
  defaultLocale: "en-US",
  content: {
    "en-US": {
      name: "Example",
      configSchema: {
        "/properties/mode": {
          title: "Mode",
          description: "Read mode",
          enumLabels: ["Stream", "Redirect"],
        },
        "/properties/nested/items/properties/a~1b": { title: "Value" },
        "/allOf/0/then": { description: "Condition" },
      },
      groups: { read: "read" },
    },
    zh: {
      name: "示例",
      groups: { read: "读取" },
      configSchema: {
        "/properties/mode": { title: "模式", enumLabels: ["文件流", "重定向"] },
        "/properties/nested/items/properties/a~1b": { title: "值" },
        "/allOf/0/then": { description: "条件" },
      },
    },
    "zh-CN": { configSchema: { "/properties/mode": { title: "读取模式" } } },
  },

  id: "test.translated",

  kind: "path",
  version: "1",
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",

        enum: ["stream", "redirect"],

        default: "stream",
      },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: { "a/b": { type: "string" } },
        },
      },
    },
    allOf: [
      {
        if: { properties: { mode: { const: "stream" } } },
        then: {},
      },
    ],
  },
  uiHints: { "/mode": { group: "read", order: 1 } },
};

test("plugin localization falls back per field and preserves original metadata and values", () => {
  const original = structuredClone(plugin);
  assertPluginContent(plugin, plugin.configSchema, plugin.uiHints);
  const display = localizePlugin(plugin, "zh-CN");
  const mode = (display.configSchema.properties as any).mode;
  expect(display.name).toBe("示例");
  expect(mode.title).toBe("读取模式");
  expect(mode.description).toBe("Read mode");
  expect(mode["x-enumLabels"]).toEqual(["文件流", "重定向"]);
  expect(mode.enum).toEqual(["stream", "redirect"]);
  expect(mode.default).toBe("stream");
  expect(display.uiHints["/mode"]).toEqual({ group: "读取", order: 1 });
  expect(
    (display.configSchema.properties as any).nested.items.properties["a/b"]
      .title,
  ).toBe("值");
  expect((display.configSchema.allOf as any)[0].then.description).toBe("条件");
  expect(localizePlugin(plugin, "fr-FR").name).toBe("Example");
  expect(plugin).toEqual(original);
});

test("translation validation rejects unsupported changes and invalid references", () => {
  const invalid: unknown[] = [
    { zh_CN: {} },
    { zh: { name: 42 } },
    { zh: { groups: { typo: "组" } } },
    { zh: { configSchema: { "/properties/missing": { title: "字段" } } } },
    { zh: { configSchema: { "/properties/mode": { default: "redirect" } } } },
    { zh: { configSchema: { "/properties/mode": { enumLabels: ["单个"] } } } },
    {
      zh: { configSchema: { "/properties/mode": { title: () => "dynamic" } } },
    },
  ];
  for (const value of invalid)
    expect(() =>
      assertPluginContent(
        {
          ...plugin,
          content: {
            ...plugin.content,
            ...(value as PluginLocalization["content"]),
          },
        },
        plugin.configSchema,
        plugin.uiHints,
      ),
    ).toThrow();
  expect(() =>
    assertSchema({ type: "string", enum: ["a"], "x-enumLabels": [] }),
  ).toThrow();
});

test("registration validates translations and management APIs return untranslated descriptors", async () => {
  const f = await fixture();
  try {
    const definition: Definition<"path"> = {
      ...plugin,
      kind: "path",
      apiVersion: 1,
      async createInstance() {
        throw new Error("Not called");
      },
    };
    expect(() =>
      f.app.plugins.register({
        ...definition,
        content: {
          ...definition.content,
          zh: { name: 1 },
        } as unknown as PluginLocalization["content"],
      }),
    ).toThrow();
    f.app.plugins.register(definition);
    const response = await f.request("/api/plugins/test.translated/versions/1");
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.name).toBeUndefined();
    expect(view.defaultLocale).toBe("en-US");
    expect(view.content).toEqual(plugin.content);
    expect(view.configSchema.properties.mode.title).toBeUndefined();
    const list = await (await f.request("/api/plugins")).json();
    expect(list.find((p: any) => p.id === plugin.id).content).toEqual(
      plugin.content,
    );
  } finally {
    await f.close();
  }
});

test("blank plugin fields and enum labels fall back independently to the resource default", () => {
  const value = structuredClone(plugin);
  value.defaultLocale = "zh";
  value.content["zh-CN"] = {
    name: "  ",
    description: " ",
    groups: { read: " " },
    configSchema: {
      "/properties/mode": { title: " ", enumLabels: [" ", "本地重定向"] },
    },
  };
  const display = localizePlugin(value, "zh-CN");
  expect(display.name).toBe("示例");
  expect(display.uiHints["/mode"]?.group).toBe("读取");
  expect((display.configSchema.properties as any).mode["x-enumLabels"]).toEqual(
    ["文件流", "本地重定向"],
  );
  expect(localizePlugin(value, "fr-FR").name).toBe("示例");
});

test("plugin authoring requires a default name and keeps schema text out of data rules", () => {
  for (const value of [
    { ...plugin, name: "Legacy name" },
    { ...plugin, translations: {} },
    { ...plugin, defaultLocale: "fr-FR" },
    { ...plugin, defaultLocale: "en-us" },
    { ...plugin, content: { "en-US": { name: " " } } },
    { ...plugin, configSchema: { ...plugin.configSchema, title: "Inline" } },
  ])
    expect(() =>
      assertPluginContent(
        value,
        value.configSchema,
        value.uiHints,
        undefined,
        true,
      ),
    ).toThrow();
});

test("access parameter APIs preserve independent identity and stage language fallbacks", async () => {
  const f = await fixture();
  try {
    f.app.plugins.register({
      id: "test.localized-access",
      kind: "processor",
      version: "1",
      apiVersion: 1,
      defaultLocale: "en-US",
      content: {
        "en-US": { name: "Example" },
        "zh-CN": { name: "示例" },
      },
      stages: {
        access: {
          defaultLocale: "zh-CN",
          content: {
            "zh-CN": {
              paramsSchema: {
                "/properties/mode": { title: "模式" },
                "/properties/hidden": { title: "隐藏字段" },
              },
            },
          },
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          paramsSchema: {
            type: "object",
            properties: {
              mode: { type: "string" },
              hidden: { type: "string" },
            },
          },
          async createInstance() {
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
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            pluginId: "test.localized-access",
            version: "1",
            config: {},
            enabledParams: ["mode"],
            onNotApplicable: "abort",
          },
        ],
      },
      access.id,
    );
    const response = await f.request("/api/access-parameters");
    expect(response.status).toBe(200);
    const [group] = (await response.json()) as AccessParameterGroup[];
    expect(localizedText(group!.plugin, "fr-FR", (c) => c.name)).toBe(
      "Example",
    );
    expect(localizedText(group!.plugin, "zh-CN", (c) => c.name)).toBe("示例");
    const display = localizePlugin(group!, "fr-FR");
    expect((display.paramsSchema.properties as any).mode.title).toBe("模式");
    expect(display.paramsSchema.properties).not.toHaveProperty("hidden");
    expect(group!.content["zh-CN"]!.paramsSchema).not.toHaveProperty(
      "/properties/hidden",
    );
    expect(group!.content["zh-CN"]!.name).toBeUndefined();
  } finally {
    await f.close();
  }
});
