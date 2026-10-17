import { expect, test } from "bun:test";
import {
  assertTranslations,
  localizePlugin,
  type PluginTranslations,
} from "../shared/plugin-localization";
import { assertSchema, type PluginView } from "../shared/config";
import { fixture } from "./helpers";
import type { Definition } from "../src/plugins/api";

const plugin: PluginView & import("../shared/config").StageView = {
  id: "test.translated",
  name: "Example",
  kind: "path",
  version: "1",
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "Mode",
        description: "Read mode",
        enum: ["stream", "redirect"],
        "x-enumLabels": ["Stream", "Redirect"],
        default: "stream",
      },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: { "a/b": { type: "string", title: "Value" } },
        },
      },
    },
    allOf: [
      {
        if: { properties: { mode: { const: "stream" } } },
        then: { description: "Condition" },
      },
    ],
  },
  uiHints: { "/mode": { group: "read", order: 1 } },
  translations: {
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
};

test("plugin localization falls back per field and preserves original metadata and values", () => {
  const original = structuredClone(plugin);
  assertTranslations(plugin.translations, plugin.configSchema, plugin.uiHints);
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
  expect(localizePlugin(plugin, "fr-FR")).toEqual(original);
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
      assertTranslations(value, plugin.configSchema, plugin.uiHints),
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
        translations: { zh: { name: 1 } } as unknown as PluginTranslations,
      }),
    ).toThrow();
    f.app.plugins.register(definition);
    const response = await f.request("/api/plugins/test.translated/versions/1");
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.name).toBe("Example");
    expect(view.translations).toEqual(plugin.translations);
    expect(view.configSchema.properties.mode.title).toBe("Mode");
    const list = await (await f.request("/api/plugins")).json();
    expect(list.find((p: any) => p.id === plugin.id).translations).toEqual(
      plugin.translations,
    );
  } finally {
    await f.close();
  }
});
